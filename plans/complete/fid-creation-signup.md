# FID Creation & Signup for Non-Farcaster Users

**Status: Complete** — Agent path (x402) is working end-to-end. Remaining work
(human onboarding, fname UX, production deploy, ops polish) extracted to separate
todo plans.

## Problem

fid.is required users to already have a Farcaster ID (FID). We needed to let anyone
create a fid.is account — including people who have never used Farcaster and AI agents
that need an online identity — by creating an onchain FID as part of the signup flow.

## Architecture

The signup flow is handled by a **standalone signup service** (`apps/signup/`), separate
from the PDS. The signup service is a Hono API on Cloudflare Workers that orchestrates:

1. x402 payment verification (agent path)
2. On-chain FID registration via Privy server wallet
3. Farcaster signer key registration via KeyGateway (key generated/stored by sync service)
4. Optional fname registration
5. PDS account creation via `ACCOUNT_CREATION_KEY`
6. Sync service setup (moves signer key to FID-keyed storage)

The PDS exposes `POST /xrpc/is.fid.account.create` gated by `ACCOUNT_CREATION_KEY` —
a shared secret that authorizes the signup service to create accounts.

The **sync service** (`apps/sync/`) generates and stores Farcaster signer keys. The
signer private key never leaves the sync service — it's encrypted with AES-256-GCM and
stored in a per-FID Durable Object.

## Decisions

| Question | Decision |
|----------|----------|
| Signup architecture | Separate signup service (`apps/signup/`), not on the PDS |
| Agent auth | x402 payment (USDC on Base) — payer address = custody address |
| Human auth (planned) | Privy — SMS + Sign in with Farcaster (see `todo/human-onboarding.md`) |
| Gas sponsorship | Privy server wallet pays gas + storage rent |
| Agent custody model | Agent provides its own Ethereum address via x402 payer |
| Recovery address | fid.is-controlled address (we can assist recovery) |
| Extra storage units | Minimum 1 unit only (users buy more later) |
| Fname for new users | Optional — agent signs EIP-712 UserNameProof, signup service registers |
| Server-side wallet | Privy server wallets for IdGateway `registerFor()` submission |
| Contract deployment | OP Sepolia for testing, OP Mainnet for production |
| Signer key custody | Sync service generates + stores encrypted; private key never exposed to client |
| Signer key registration | KeyGateway `addFor()` via Privy server wallet during signup |

## Completed Work

### Agent Path (x402) — Working

**Flow:**
1. Agent fetches `GET /api/registration-params?address=0x...`
   - Signup calls sync service `POST /generate-signer` — generates ed25519 keypair, stores encrypted private key
   - Returns EIP-712 typed data for both `Register` and `Add` (signer), pricing, deadline
2. Agent signs both `Register` and `Add` typed data
3. Agent calls `POST /api/create` with `{ registerSig, addSig, signerPubKey, signerMetadata, deadline }` — gets 402 response
4. Agent retries with x402 payment header (USDC on Base)
5. Signup service verifies payment, extracts payer address
6. If payer has no FID: Privy server wallet calls `IdGateway.registerFor()` on Optimism
7. If payer already has FID: uses existing FID
8. Privy server wallet calls `KeyGateway.addFor()` to register signer key on-chain
9. Optional: registers fname via `fnames.farcaster.xyz` API
10. Creates PDS account via `POST /xrpc/is.fid.account.create` with `ACCOUNT_CREATION_KEY`
11. Calls sync service `POST /setup` — moves pending signer key to FID-keyed storage
12. Returns session tokens + DID + handle + FID + signerPubKey (no private key)

**Files:**
- `apps/signup/src/index.ts` — Hono app with `/api/registration-params` and `/api/create` routes
- `apps/signup/src/x402.ts` — Custom x402 middleware (verifies payment, extracts payer address, settles after success)
- `apps/signup/src/farcaster-contracts.ts` — Contract interactions: `getFidForAddress()`, `getIdGatewayNonce()`, `getRegistrationPrice()`, `registerForFid()` via Privy
- `apps/signup/src/eip712.ts` — EIP-712 typed data builders for `registerFor` and fname `UserNameProof`
- `apps/signup/src/fname.ts` — Fname registration via `fnames.farcaster.xyz` API
- `packages/pds/src/xrpc/fid-account.ts` — `createAccount()` handler gated by `ACCOUNT_CREATION_KEY`
- `scripts/test-agent-account.ts` — End-to-end test script (fresh wallet, USDC funding, x402 payment)

**Contract config (configurable via env vars):**
- `ID_REGISTRY_ADDRESS` — IdRegistry contract (default: OP Mainnet)
- `ID_GATEWAY_ADDRESS` — IdGateway contract (default: OP Mainnet)
- `CHAIN_ID` — Chain ID (default: 10 = Optimism, 11155420 = OP Sepolia for testing)

**OP Sepolia test contracts:**
- IdRegistry: `0x0acc54228887f9717633aD107FC683B4d66C6164`
- IdGateway: `0x967e224796487113c9F268E3c73874eDBE8b73C5`
- StorageRegistry: `0xe2Ec0AB188bE1e1A8e1B12c747653F2a648e9E90`
- MockPriceFeed: `0x2D3F96f25eA68B15DE0330AD7A054a1070eEb53B`

### PDS Account Creation Endpoint — Working

- `POST /xrpc/is.fid.account.create` — accepts `{ fid, handle?, farcasterAddress? }`
- Gated by `Authorization: Bearer <ACCOUNT_CREATION_KEY>`
- Creates keypair, stores identity, activates account, emits identity event, registers in D1
- Idempotent — returns tokens if account already exists

### Signer Key Management — Working

Signer keys are generated and stored by the **sync service** (`apps/sync/`), never
exposed to the client:

1. Signup service calls `POST /generate-signer` on sync service with the agent's address
2. Sync service generates ed25519 keypair, encrypts private key with AES-256-GCM, stores in
   a pending DO keyed by `pending:${address}`, returns only the public key
3. Signup service builds EIP-712 `Add` typed data with the public key, agent signs it
4. After FID registration + on-chain signer registration, signup calls `POST /setup` on sync service
5. Sync service moves the encrypted key from the pending DO to the FID-keyed DO (`fid:${fid}`)
6. The signer private key never leaves the sync service

**Files:**
- `apps/sync/src/sync-do.ts` — `generateSigner()`, `getPendingSignerKey()`, `setupWithEncryptedKey()`
- `apps/sync/src/crypto.ts` — AES-256-GCM encryption/decryption
- `apps/sync/src/index.ts` — `POST /generate-signer`, `POST /setup` endpoints

### Test Infrastructure — Working

- `scripts/test-agent-account.ts` — creates fresh wallet per run, funds with Base Sepolia USDC, tests full flow
- Funder wallet transfers exact x402 price (0.01 USDC) to test wallet
- x402 uses EIP-3009 `TransferWithAuthorization` (gasless USDC signatures)

## Extracted Follow-up Work

- `plans/todo/human-onboarding.md` — Human signup path (Privy + web frontend)
- `plans/todo/agent-fname-registration.md` — Fname registration in agent flow
- `plans/todo/fid-creation-production-deploy.md` — Production deployment (OP Mainnet)
- `plans/todo/fid-creation-ops-polish.md` — Operational polish (monitoring, rate limiting)
