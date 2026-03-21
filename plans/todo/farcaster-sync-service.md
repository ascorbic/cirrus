# Farcaster Sync Service

## Overview

A Cloudflare Worker (`apps/sync/`) that bridges AT Protocol and Farcaster for fid.is users. When a user creates an ATProto record (post, like, repost, follow, profile update) on their PDS, the sync service writes the corresponding Farcaster message to Hypersnap using the user's registered ed25519 signer key.

**Phase 1 (this plan):** ATProto → Farcaster (read PDS events, write to Hub)
**Phase 2 (future):** Farcaster → ATProto (read Hub events, write to PDS)

## Architecture

```
Agent / Client                     Farcaster Hub (Hypersnap)
    │                                     ▲
    │  POST /sync (after PDS write)       │  POST /v1/submitMessage
    │                                     │  (ed25519-signed protobuf)
    ▼                                     │
┌─────────────────────────────────────────────┐
│  apps/sync/ — Cloudflare Worker             │
│                                             │
│  ┌─────────────────────────────────┐        │
│  │  SyncDurableObject (per user)   │        │
│  │                                 │        │
│  │  - ed25519 signer key (enc.)   │        │
│  │  - sync state & config          │        │
│  │  - delete mapping (rkey→hash)   │        │
│  └─────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

### Key Properties

- **Separate worker** in `apps/sync/`, not part of the PDS worker
- **One Durable Object per user** — stores encrypted signer key, sync config, delete mapping
- **Client-initiated sync** — the client (agent) notifies the sync service after writing to the PDS. No PDS changes required.
- **Writes to Hub** — constructs and signs Farcaster messages, submits via Hub HTTP API
- **Encrypted signer storage** — ed25519 private key encrypted with a symmetric key stored as a Worker env secret

### Event Delivery: Client → Sync Service

The PDS is kept as close to the reference implementation as possible — no webhooks or custom hooks added. Instead, the **client** notifies the sync service after writing a record to the PDS.

**Phase 1 (current): Client-initiated**
- After the agent calls `com.atproto.repo.createRecord` on the PDS, it also calls `POST /sync` on the sync service with the record details
- Simple, no PDS changes, works for agents that control their own client
- Limitation: doesn't work if the user posts from a standard Bluesky client (e.g., bsky.app)

**Future: Relay subscription**
- When fid.is has its own relay, a single firehose subscriber watches for commits from `did:web:*.fid.is` DIDs and dispatches to sync DOs
- Covers all clients (Bluesky app, third-party clients, etc.)
- No PDS changes required — uses standard AT Protocol firehose

## Dependencies

### On-Chain Signer Registration (BLOCKER)

The sync service must sign Farcaster messages with an ed25519 key registered in the KeyRegistry. This is required for Phase 1 — without it, the Hub will reject submitted messages.

**Contracts needed:**
- KeyGateway: `0x00000000fc56947c7e7183f8ca4b62398caadf0b` (Optimism mainnet)
- KeyGateway on OP Sepolia: needs deployment (see `fid-contracts.md` Phase 2)
- SignedKeyRequestValidator: needed for metadata verification

### KeyGateway Deployment to OP Sepolia (BLOCKER for testing)

`fid-contracts.md` Phase 2 must be completed to test signer registration on testnet.

### Service Keys (BLOCKER for Phase 2)

Service keys (`plans/todo/service-keys.md`) are needed for Phase 2 (Farcaster → ATProto) when the sync service writes to the PDS. For Phase 1, the sync service receives record data directly from the client and writes to the Hub — no PDS reads required, so service keys are not needed.

## What Gets Synced (Phase 1: ATProto → Farcaster)

| ATProto Record Type | Farcaster Message Type | Notes |
|---------------------|----------------------|-------|
| `app.bsky.feed.post` | Cast (`MESSAGE_TYPE_CAST_ADD`) | Text, embeds, reply parent |
| `app.bsky.feed.like` | Reaction like (`REACTION_TYPE_LIKE`) | Needs AT URI → Farcaster cast ID mapping |
| `app.bsky.feed.repost` | Reaction recast (`REACTION_TYPE_RECAST`) | Same mapping challenge |
| `app.bsky.graph.follow` | Link follow | Needs DID → FID mapping |
| `app.bsky.actor.profile` | UserData updates | Display name, bio, PFP URL |

### Record Deletions

| ATProto Operation | Farcaster Message Type |
|-------------------|----------------------|
| `deleteRecord` on `app.bsky.feed.post` | `MESSAGE_TYPE_CAST_REMOVE` |
| `deleteRecord` on `app.bsky.feed.like` | `MESSAGE_TYPE_REACTION_REMOVE` |
| `deleteRecord` on `app.bsky.feed.repost` | `MESSAGE_TYPE_REACTION_REMOVE` |
| `deleteRecord` on `app.bsky.graph.follow` | `MESSAGE_TYPE_LINK_REMOVE` |

### Mapping Challenges

- **DID → FID mapping (easy):** Deterministic for fid.is users — `did:web:NNN.fid.is` → FID `NNN`. For non-fid.is users, a lookup is needed (D1 user registry or skip).
- **AT URI → Farcaster cast ID (for likes/reposts):** When a user likes/reposts another user's post, we need the target's Farcaster cast hash. This only works if:
  - The target is a fid.is user AND their post was synced (we have the mapping), OR
  - The target's ATProto post originated from a Farcaster cast (Phase 2 mapping, future)
  - Otherwise: skip the like/repost sync for that record
- **Reply threading:** ATProto reply parents reference an AT URI. Same mapping challenge — can only thread replies to posts with known Farcaster hashes.
- **Embeds:** ATProto posts can embed images (blob refs), links, and quote posts. Images need their blob URL included in the cast. Quote posts need Farcaster cast ID mapping.
- **Text length:** Farcaster casts are limited to 1024 bytes. ATProto posts have a 300-grapheme limit (roughly 1200 bytes max). Most posts will fit, but truncation may be needed in edge cases.

## Signer Key Management

### Generation & Storage

1. During account creation (agent signup or miniapp), generate a new ed25519 keypair
2. Encrypt the private key with a symmetric AES key (stored as `SIGNER_ENCRYPTION_KEY` env secret)
3. Store encrypted private key + public key in the SyncDurableObject's SQLite
4. Register the public key on-chain via `KeyGateway.addFor()`
5. Return the signer public key (and optionally private key for agents) in the creation response

### Encryption

```
plaintext_key (32 bytes) → AES-256-GCM encrypt with SIGNER_ENCRYPTION_KEY → ciphertext + IV + tag
```

Store as a single blob (IV + ciphertext + tag) in SQLite. Decrypt on demand when signing Farcaster messages.

### On-Chain Registration

The ed25519 public key must be registered in the Farcaster KeyRegistry via `KeyGateway.addFor()`. This requires:

1. **FID owner signature** — EIP-712 `Add` message signed by the user's custody address
2. **SignedKeyRequest metadata** — EIP-712 signed by the `requestFid` owner (the fid.is miniapp)
3. **Gas payment** — Privy server wallet submits the transaction

**`requestFid`:** The fid.is Farcaster miniapp's FID. Configuration mechanism TBD (env var or other).

### Farcaster Message Signing

To submit a message to the Hub, the sync service must:

1. Construct a Farcaster `MessageData` protobuf (type, fid, timestamp, body)
2. Hash the serialized data with BLAKE3
3. Sign the hash with the ed25519 private key
4. Wrap in a `Message` protobuf (data, hash, hashScheme, signature, signatureScheme, signer)
5. Submit via `POST /v1/submitMessage` with the serialized protobuf

This can use `@farcaster/core` for message construction and signing, or be implemented directly with protobuf + ed25519 libraries.

## Account Creation Integration

### Agent Signup Flow (Primary for Phase 1)

Current flow:
1. Agent fetches `GET /api/registration-params?address=0x...` — gets EIP-712 typed data
2. Agent signs `Register` typed data
3. Agent calls `POST /api/create` with x402 payment
4. Signup service registers FID via `registerFor()`
5. Signup service creates PDS account via API key
6. Returns session tokens + DID + handle + FID

New flow (with signer):
1. Agent fetches `GET /api/registration-params?address=0x...` — gets `Register` AND `Add` EIP-712 typed data
2. Agent signs both `Register` and `Add` typed data
3. Agent calls `POST /api/create` with `{ registerSig, addSig, signerPubKey?, deadline }` + x402 payment
4. Signup service registers FID via `registerFor()`
5. Signup service generates ed25519 keypair (or uses agent-provided pubkey)
6. Signup service builds `SignedKeyRequestMetadata` (signs with miniapp's key as `requestFid`)
7. Signup service registers signer via `KeyGateway.addFor()` (Privy wallet pays gas)
8. Signup service creates PDS account via API key
9. Signup service initializes SyncDurableObject (stores encrypted signer key, config)
10. Returns session tokens + DID + handle + FID + signer public key

**Key decision: Agent-provided vs service-generated keypair**
- **Agent provides pubkey** (Option A): Agent generates ed25519 keypair locally, sends public key in step 1. Agent keeps private key. More secure — service never sees private key. But sync service also needs the key to sign on the agent's behalf.
- **Service generates** (Option B): Signup service generates keypair, registers it, stores encrypted private key in sync DO, returns private key to agent. Simpler. Agent and sync service both have the key.
- **Recommendation:** Option B — the sync service needs the private key regardless, so the service must generate or receive it. Returning it to the agent lets the agent also sign messages directly if desired.

### Miniapp Flow (Future — after Phase 1)

Current flow:
1. User authenticates via Quick Auth or SIWF
2. Account created on PDS
3. Profile populated from Farcaster data
4. Relay crawl requested

New steps (sync setup):
- User must explicitly opt in to enable sync (off by default)
- UX for enabling sync is TBD
- When enabled:
  1. Generate ed25519 signer keypair
  2. User signs `Add` EIP-712 message via miniapp SDK (wallet signing)
  3. Register signer on-chain via `KeyGateway.addFor()`
  4. Store encrypted signer key in SyncDurableObject
  5. Enable sync

### Signer Registration Timing

**For agents (Phase 1):** Blocking, during `POST /api/create`. The on-chain tx adds ~2-4s but the agent is already waiting for FID registration which has the same latency. Both txs can potentially be batched or parallelized.

**For miniapp users (future):** TBD — could be blocking with a loading state, or async with a status indicator.

## Sync DO Design

### Deduplication Strategy

No dedup mapping table is needed for preventing re-import loops. Every Farcaster message includes the `signer` public key that signed it. In Phase 2 (Farcaster → ATProto), the sync service simply skips any Hub message where `signer === sync_signer_public_key` — those originated from ATProto and should not be imported back.

A lightweight **delete mapping** table is still needed: when an ATProto record is deleted, the sync service needs to know the corresponding Farcaster message hash to submit a remove message.

### SQLite Schema

```sql
-- Sync configuration
CREATE TABLE sync_config (
    fid INTEGER PRIMARY KEY,
    did TEXT NOT NULL,
    pds_url TEXT NOT NULL,
    signer_key_encrypted BLOB NOT NULL,  -- AES-256-GCM encrypted ed25519 private key
    signer_key_public TEXT NOT NULL,      -- hex-encoded ed25519 public key
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

-- Delete mapping: ATProto rkey → Farcaster hash
-- Used only to look up the Farcaster hash when a record is deleted on ATProto
CREATE TABLE sync_mapping (
    atproto_rkey TEXT NOT NULL,           -- ATProto record key
    collection TEXT NOT NULL,             -- ATProto collection (e.g., app.bsky.feed.post)
    farcaster_hash TEXT NOT NULL,         -- Farcaster message hash returned by Hub
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (collection, atproto_rkey)
);
```

### Sync Flow (per event)

```
Agent writes a record to PDS (com.atproto.repo.createRecord)
  → Agent calls POST /sync on the sync service with:
    { fid, did, action: "create"|"delete", collection, rkey, record? }
  → Sync worker routes to user's SyncDurableObject by FID
  → DO checks if sync is enabled
  → DO decrypts ed25519 signer key
  → For creates:
      → Transform ATProto record → Farcaster MessageData
      → Sign with ed25519 key (BLAKE3 hash + Ed25519 signature)
      → Submit to Hub via POST /v1/submitMessage
      → Store rkey → farcaster_hash in sync_mapping (for future deletes)
  → For deletes:
      → Look up farcaster_hash from sync_mapping by collection + rkey
      → Construct remove message (CAST_REMOVE, REACTION_REMOVE, etc.)
      → Sign and submit to Hub
      → Delete mapping from sync_mapping
```

**No PDS changes required.** The sync service is notified by the client, not the PDS.

## Worker Structure

```
apps/sync/
├── src/
│   ├── index.ts              -- Worker entry point, sync endpoint, status endpoints
│   ├── sync-do.ts            -- SyncDurableObject class
│   ├── hub-client.ts         -- Farcaster Hub submitMessage client
│   ├── message-builder.ts    -- ATProto record → Farcaster message constructors
│   ├── signer.ts             -- Ed25519 signing (BLAKE3 hash + signature)
│   ├── crypto.ts             -- Signer key encryption/decryption (AES-256-GCM)
│   └── types.ts              -- Shared types
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

### API Endpoints (on sync worker)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /sync` | Bearer token (user's access JWT or API key) | Sync a record to Farcaster (called by agent after PDS write) |
| `POST /setup` | Internal API key | Initialize sync for a user (called during account creation) |
| `GET /status/:fid` | Internal API key | Get sync status for a user |
| `POST /enable/:fid` | Internal API key | Enable sync |
| `POST /disable/:fid` | Internal API key | Disable sync |

## Signup Service Changes (`apps/signup/`)

### `GET /api/registration-params`

**New response fields:**
```json
{
  "...existing fields...",
  "addTypedData": {
    "domain": { "name": "Farcaster KeyGateway", "..." },
    "types": { "Add": [ "..." ] },
    "primaryType": "Add",
    "message": { "owner": "0x...", "keyType": 1, "key": "0x...", "..." }
  },
  "signerPubKey": "0x..."
}
```

- Signup service generates an ed25519 keypair
- Returns the `Add` EIP-712 typed data pre-filled with the generated public key
- Agent signs both `Register` and `Add` typed data

### `POST /api/create`

**New request fields:**
```json
{
  "...existing fields...",
  "addSig": "0x...",
  "signerPubKey": "0x..."
}
```

**New steps after FID registration:**
1. Build `SignedKeyRequestMetadata` (sign with miniapp's requestFid key)
2. Call `KeyGateway.addFor()` via Privy wallet
3. Wait for tx receipt
4. Call sync service `POST /setup` with encrypted signer key + config

### New files

| File | Change |
|------|--------|
| `apps/signup/src/farcaster-contracts.ts` | Add KeyGateway ABI + `addSignerForFid()` function |
| `apps/signup/src/eip712.ts` | Add `Add` and `SignedKeyRequest` EIP-712 type definitions |
| `apps/signup/src/index.ts` | Add signer flow to `/api/create`, `Add` typed data to `/api/registration-params` |

## Environment Variables

### Sync Worker (`apps/sync/`)
```
HUB_API_URL           -- Farcaster Hub base URL (default: https://haatz.quilibrium.com/v1)
SIGNER_ENCRYPTION_KEY -- Symmetric AES-256 key for encrypting ed25519 signer keys
INTERNAL_API_KEY      -- For setup/status/enable/disable endpoints
JWT_SECRET            -- For verifying user access JWTs on POST /sync
PDS_DOMAIN            -- Base domain (e.g., fid.is)
```

### Signup Service (new env vars)
```
KEY_GATEWAY_ADDRESS   -- KeyGateway contract address
REQUEST_FID           -- Fid.is miniapp's FID (for SignedKeyRequest metadata)
REQUEST_FID_KEY       -- Private key for signing SignedKeyRequest metadata
SYNC_SERVICE_URL      -- URL of sync worker (for POST /setup during account creation)
SYNC_SERVICE_KEY      -- API key for sync worker
```

No new PDS environment variables required.

## Open Decisions

1. **requestFid configuration** — How to configure the miniapp's FID (env var vs other)
2. **Sync enable UX for miniapp** — Where/how miniapp users turn on sync (future, not needed for Phase 1 agent flow)
3. **Cross-user references** — How to handle likes/reposts that reference posts from non-fid.is users (skip vs external lookup)
4. **Signer key return to agent** — Should the ed25519 private key be returned in the `POST /api/create` response so agents can also sign Hub messages directly?
5. **Message construction library** — Use `@farcaster/core` for protobuf message building, or implement directly with lighter dependencies?
6. **Rate limiting** — Hub submitMessage rate limits and how to handle them
7. **Embed handling** — How to translate ATProto blob refs (images) to URLs the Hub can reference (use PDS blob URL?)
8. **POST /sync auth** — Should agents authenticate with their PDS access JWT, a separate sync API key, or the internal API key?

## Implementation Order

1. **KeyGateway + SignedKeyRequestValidator deployment** to OP Sepolia (`fid-contracts.md` Phase 2) — BLOCKER for testing
2. **Signer registration in signup service** — Add `Add` EIP-712 typed data + `KeyGateway.addFor()` to agent creation flow
3. **Sync worker scaffold** — `apps/sync/` with DO, encrypted key storage, setup endpoint, `POST /sync` endpoint
4. **Hub write client** — Farcaster message construction, ed25519 signing, `POST /v1/submitMessage`
5. **Cast sync** — ATProto `app.bsky.feed.post` → Farcaster cast (highest value, simplest)
6. **Profile sync** — ATProto profile → Farcaster UserData
7. **Delete sync** — Record deletions → Farcaster remove messages (using sync_mapping)
8. **Like/repost/follow sync** — More complex due to cross-user ID mapping
9. **Miniapp integration** — UI for enabling sync, signer registration via miniapp SDK (Phase 1.5)
10. **Relay subscription** — Replace client-initiated sync with relay firehose listener (covers all clients)
11. **Phase 2: Farcaster → ATProto** — Hub polling + PDS writes via service keys (signer-based dedup: skip messages signed by sync signer)

## Related Plans

- `plans/todo/service-keys.md` — Service key auth (needed for Phase 2, not Phase 1)
- `plans/todo/agent-farcaster-signer.md` — Agent signer registration (subsumed by this plan's signup integration)
- `plans/reference/farcaster-onchain-signers.md` — On-chain signer reference
- `fid-contracts.md` — OP Sepolia contract deployment (Phase 2 needed for testing)
