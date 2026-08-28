# Atproto Spaces in Cirrus

- Status: Draft
- Date: 2026-08-28
- Depends on: [proposal 0016](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data), `@atproto/space@alpha`, the `permissioned-data-alpha` branch of the reference PDS
- Scope: the Cirrus PDS only. A standalone space host is discussed as a consequence of the design, not specified here.

## Summary

Add atproto spaces to Cirrus behind a feature flag, with all space state isolated from the public repository so that alpha-era breaking changes can be absorbed by wiping space data and never by touching the account's MST, blobs or OAuth state.

The account acts in three roles:

1. **Repo host** – serving the account's own permissioned repos, one per space it has written into, whether it owns the space or not.
2. **Space host** – for spaces the account owns: issuing credentials, tracking the writer set, routing write notifications, managing membership.
3. **User's PDS** – minting delegation tokens so the operator's apps can read spaces hosted elsewhere.

Cirrus is single-user, which collapses a lot of the reference implementation's generality. Every permissioned repo Cirrus serves is the operator's. Every space it hosts has the operator's DID as authority. That is what makes a Worker-and-Durable-Object implementation tractable rather than a port.

## Goals

- Interoperate with the reference alpha PDS, rsky and the bulletin.my sample app for the personal-data and shared-space cases.
- Keep the public repo path unchanged in behaviour and schema, except for one deliberate improvement to blob handling (see [Blobs](#blobs)).
- Make "delete all space data" a single operation that cannot touch anything else.
- Keep R2 I/O out of Durable Objects, matching the existing Cirrus constraint that the account DO holds the firehose WebSocket and must never block on storage.
- Design the engine so the same Durable Object class can later serve a dedicated authority DID with no account attached.

## Non-goals

- Account migration of permissioned repos. The protocol has no import method yet. Export only.
- Confidentiality. Spaces are access control. Nothing is encrypted at rest beyond what R2 and DO storage already do.
- Multi-account. The single-user constraint is load-bearing throughout.
- A stable release. Everything here is alpha and the flag says so.

## User stories

Ordered by how soon they matter, with the acceptance test for each.

**S1. An app stores private data on my PDS.** I sign in to an app (bulletin.my, a bookmarks app) with OAuth. It requests `space:<type>` on my own authority. It creates a space under my DID, writes records, reads them back. Nobody else can read them. *Test: bulletin.my login, create board, write a note, read it via a second session, confirm an unauthenticated `getRecord` is refused.*

**S2. I read a space someone else hosts.** My app asks my PDS for a delegation token, exchanges it at the other host for a credential, syncs. My PDS's only job is minting the token. *Test: read a friend's bulletin board hosted on the alpha PDS.*

**S3. I write into a space someone else hosts.** I post to a forum hosted elsewhere. Cirrus stores my repo for that space, and notifies the authority after each write so syncers pull it. *Test: post to a space on the reference PDS; the reference's `listRepos` shows my DID with the right rev and hash.*

**S4. I host a shared space.** Friends write from their own PDSes. Mine issues credentials, records the writer set from their `notifyWrite` calls, and fans out notifications to registered syncers. *Test: two writers on two PDSes, one syncer, all three observe consistent state after each write.*

**S5. I gate a space and revoke access.** Member-list policy. I remove a member and their next credential request fails. Their existing credential expires within two hours. *Test: remove, confirm `getSpaceCredential` returns `UserNotAuthorized`, confirm `getBlob` with the old credential still works until expiry and fails after.*

**S6. I publish a large file into a space.** A blob referenced from a space record is fetchable only with a credential for that space, never from the public `sync.getBlob` endpoint, even with the CID. *Test: upload, reference from a space record, confirm public `getBlob` returns 404 and space `getBlob` streams with a credential.*

**S7. An alpha build breaks the schema.** I upgrade, the space DOs refuse to open, I run `pds spaces reset`, my public repo is untouched. *Test: bump the schema version constant, deploy, confirm space endpoints return a clear error and the firehose is unaffected, run reset, confirm clean state.*

**S8. I want to leave.** `pds spaces export` writes one CAR per space so the data is not lost even though it cannot yet be imported elsewhere. *Test: export, verify each CAR against its commit with `@atproto/space`'s consumer.*

**S9. I run an org's space host.** Not in this spec, but the engine must not prevent it. The DO must take its authority DID, keypair, DID resolver and blob bucket from the caller rather than reading `env.DID`. *Test: a unit test that instantiates the space DO with a DID that is not the account's.*

## Architecture

### Topology

```
Worker (stateless)
  ├── existing routes, AccountDurableObject, BLOBS
  ├── /xrpc/com.atproto.space.*        ─┐
  ├── /xrpc/com.atproto.simplespace.*   ├─ SpaceDurableObject (one per space URI)
  └── dashboard, CLI RPC               ─┘
                                        └─ SpaceIndexDurableObject (singleton)
```

**`SpaceDurableObject`** – one instance per space, `idFromName(spaceUri)`. Holds everything Cirrus knows about that space: the operator's permissioned repo, its oplog and set-hash state, blob references, and when the operator is the authority, the `simplespace` config, member list, writer set, notification registrations and the outbound notification queue. Also the replay tables for DPoP proofs and delegation tokens presented against that space.

**`SpaceIndexDurableObject`** – singleton, `idFromName("spaces")`. A registry of space URIs with role flags, timestamps and lifecycle state. Serves `listSpaces`, the dashboard, export and reset. Nothing else reads it on the hot path, because the space DO id is derived from the URI.

**`AccountDurableObject`** – untouched. No new tables, no new RPC methods. The firehose WebSocket and the MST never share a DO with space traffic.

Both new classes use the same `DATA_LOCATION` handling as the account DO, including the `eu` jurisdiction path. Space data must not end up in a different jurisdiction from the account.

Why a separate index DO rather than a table in the account DO: it keeps the promise that the account schema never changes for spaces, and it makes reset a matter of deleting two namespaces of DOs and one R2 prefix. The cost is that creation is a two-step write. The index is written first with state `pending`, then the space DO is initialised, then the index entry is marked `active`. A `pending` entry that never activates is cleaned up by the index DO's alarm and shown as such in the dashboard. Reads never depend on the index.

### Storage in `SpaceDurableObject`

All tables live in the DO's SQLite. Types are SQLite types.

```sql
-- One row. schema_version is checked on every open.
meta (
  uri TEXT, authority TEXT, type TEXT, skey TEXT,
  is_authority INTEGER,          -- authority == operator DID
  created_at TEXT, deleted_at TEXT,
  schema_version INTEGER
)

-- Operator's permissioned repo in this space.
record (
  collection TEXT, rkey TEXT, cid TEXT, bytes BLOB, rev TEXT, indexed_at TEXT,
  PRIMARY KEY (collection, rkey)
)
record_blob (blob_cid TEXT, collection TEXT, rkey TEXT, PRIMARY KEY (blob_cid, collection, rkey))
repo_state (id INTEGER PRIMARY KEY CHECK (id = 1), set_hash BLOB, rev TEXT)
oplog (rev TEXT, idx INTEGER, collection TEXT, rkey TEXT, cid TEXT, prev TEXT, PRIMARY KEY (rev, idx))

-- Authority role only.
config (id INTEGER PRIMARY KEY CHECK (id = 1), policy TEXT, managing_app TEXT, app_access TEXT, app_allowed TEXT)
member (did TEXT PRIMARY KEY)
writer (did TEXT PRIMARY KEY, rev TEXT, hash BLOB)
notify_registration (service TEXT PRIMARY KEY, endpoint TEXT, expires_at TEXT)
notify_queue (id INTEGER PRIMARY KEY, service TEXT, body TEXT, attempts INTEGER, next_at INTEGER)

-- Replay protection, both roles.
replay (kind TEXT, key TEXT, expires_at INTEGER, PRIMARY KEY (kind, key))
```

This mirrors the reference's `002-space` migration closely enough that behaviour can be compared table for table, minus the `space` column on every row, which the per-space DO makes redundant.

`set_hash` is the 2048-byte LtHash state, persisted after every write. `oplog` is retained for a window (default 30 days or 10,000 ops, whichever is smaller) and compacted by the DO alarm. The reference has no compaction yet; ours must, because DO SQLite is billed and capped.

Schema versioning is a constant in the package. On open, a mismatch with `meta.schema_version` puts the DO into a refusing state: every RPC throws `SpacesSchemaOutdated`, the Worker maps it to a 503 with a message pointing at `pds spaces reset`. There is no migration path between alpha versions. That is the same policy Bluesky states for the reference alpha, applied honestly.

### Records, revisions and commits

Records are stored as dag-cbor bytes with their CID, computed in the Worker with `cidForLex` from `@atproto/lex-cbor`, the same path Cirrus uses for public records. Lexicon validation reuses `validation.ts` with the reference's `validate` semantics: unset validates known lexicons and reports `unknown` otherwise.

Each write batch gets one TID `rev`, strictly greater than `repo_state.rev`. The DO applies the batch with `transactionSync`: mutate `record`, update `record_blob`, apply each op to the LtHash (`RepoCommit.applyOp` from `@atproto/space`), append to `oplog`, persist `repo_state`. It returns `{ rev, hash, state, ops }`.

Commits are signed in the Worker, not the DO. The proposal requires a fresh `ikm` per reader, so a signature is never stored. `getLatestCommit`, the head page of `listRepoOps` and `getRepo` each call `RepoCommit.fromState(state).sign(ctx, keypair)` with the account keypair the Worker already holds. The DO never sees the signing key.

### Auth

Requests arrive under four authentication schemes. A single middleware classifies them before routing, in this order:

1. **Space credential** – `Authorization: DPoP <jwt>` whose unverified `typ` header is `atproto-space-credential+jwt`, plus a `DPoP` proof. Verified with `verifySpaceToken` from `@atproto/space`: signature against the issuer's `#atproto_space` key falling back to `#atproto`, `sub` equal to the requested space, `iss` equal to the space's authority DID, `cnf.jkt` equal to the proof key's thumbprint, proof `htm`/`htu`/`ath`/`iat` valid, proof `jti` unseen. The `jti` check is an RPC to the space DO's `replay` table. Everything else is stateless in the Worker.
2. **Delegation token** – `Authorization: Bearer <jwt>` with `typ` `atproto-space-delegation+jwt`, only on `getSpaceCredential`. Signature against the issuer's `#atproto` key, `aud` equal to `<operatorDid>#atproto_space_host`, single use by `(iss, jti)` in the space DO's `replay` table, plus a DPoP proof with no `ath`.
3. **Service auth** – existing `verifyServiceJwt` for `notifyWrite` and `notifySpaceDeleted`, with `lxm` checked. `notifyWrite` additionally requires `iss` to equal the `repo` in the body and `aud` to equal the operator DID. The reference checks the bare DID as audience, not the `#atproto_space_host` fragment, and we match it.
4. **OAuth and operator sessions** – the existing path, extended so `space:` scopes parse and match.

Key resolution for foreign issuers goes through the existing DID resolver and cache, with a forced refresh on signature failure to survive key rotation. Resolution failures are 401s, never 500s.

Which existing credentials may write to spaces: OAuth tokens carrying a matching `space:` grant, and the operator's own full-access sessions (`AUTH_TOKEN`, password and passkey sessions). App passwords are excluded in the alpha. They are a deprecated credential class and there is no reason to widen their reach into a new data model. This is stricter than the reference, which treats any legacy access token as full-access.

Because Cirrus hosts one account, every OAuth read of a permissioned repo on this PDS is a self read. `read` and `read_self` differ here only in whether `getDelegationToken` is permitted. The `repo` parameter on every repo-host method must equal the operator DID or the response is `RepoNotFound`.

### OAuth provider changes

In `@getcirrus/oauth-provider`:

- Add `space` to `GRANULAR_RESOURCES`, parsed with `SpacePermission.fromString` from `@atproto/oauth-scopes@alpha`. If that export is absent in a given alpha build, the parser rejects `space:` scopes outright rather than accepting an approximation.
- Add the `manage` axis to matching, mapped onto `simplespace` methods: `manage=create` for `createSpace`, `manage=update` for `updateSpace`, `addMember` and `removeMember`, `manage=delete` for `deleteSpace`.
- Consent screen: resolve the space type NSID to its declaration and display `name`, using the same resolver the `include:` permission-set path already has. Fall back to the raw NSID with a warning. Wildcards on both `authority` and `spaceType` get a prominent warning, per the proposal.
- `authority=self` is resolved to the operator DID at grant time, as the proposal requires, so a stored grant never contains `self`.
- When the flag is off, `space:` scopes fail at authorization with `invalid_scope` and the OAuth metadata does not advertise the resource.

### Blobs

This is the one place the design deliberately improves on the reference rather than matching it.

Today Cirrus stores uploads at `${did}/${cid}` in R2 and `sync.getBlob` reads that key directly from the Worker. The reference alpha does the equivalent, which means a blob referenced only by a space record is fetchable by anyone who learns its CID, and removing a member does not remove their access to the bytes. The protocol's intent is that `space.getBlob` is credential-gated, and a key layout is the only enforcement that costs nothing per request.

New layout:

| Key | Meaning | Served by |
|---|---|---|
| `${did}/staged/${cid}` | uploaded, not yet referenced | nothing |
| `${did}/${cid}` | referenced by at least one public record | `sync.getBlob`, unchanged |
| `${did}/space/${spaceId}/${cid}` | referenced by a record in that space | `space.getBlob` only |

`spaceId` is the base32 SHA-256 of the space URI. The same blob referenced from two spaces is stored twice. That is a deliberate trade: per-space prefixes make space deletion and full reset a prefix delete with no cross-space reference counting, and duplicate references are rare.

`repo.uploadBlob` writes to `staged/`. On any record write, public or space, the Worker parses the record for blob refs before calling the DO, and for each ref not already present at its destination key it copies `staged/` to the destination with a streaming get and put. The copy completes before the DO commit is applied, so a relay or syncer that reacts to the commit never sees a 404. Concurrent writes referencing the same staged blob perform idempotent copies. `staged/` is expired by an R2 lifecycle rule after seven days. No DO alarm and no DO involvement in any of this.

This change applies to the public path regardless of the flag, because it is a correctness improvement in its own right and because the flag must not fork the blob layout. It ships as its own change, before the spaces work, with its own tests. Existing blobs at `${did}/${cid}` are unaffected.

`space.getBlob` verifies the credential or scope, asks the space DO whether the CID is referenced in that space, then streams from R2 in the Worker with `Cache-Control: private, no-store` and `Vary: Authorization, DPoP`, alongside the same `nosniff`, `attachment` and sandboxing CSP headers the public endpoint sends. The cache headers are not optional: a blob proxy such as Cumulus, or anything else sitting in front of the PDS with a shared cache, must never store a response whose authorisation was per-credential, and `no-store` is the only signal it can be relied on to honour. Credential-aware caching keyed by space with purge on `removeMember` is a possible later step, but it belongs in the proxy and needs the proxy to understand credentials first.

The 60 MB buffered upload limit is inherited from the public path and is not a spaces concern.

### Write path

`createRecord`, `putRecord`, `deleteRecord` and `applyWrites`:

1. Classify auth. Assert the `space:` grant covers `(type, authority, skey)`, the collection and the action, or that the session is a full-access operator session.
2. Assert `repo` equals the operator DID.
3. Parse and validate each record. Compute CIDs. Extract blob refs.
4. Promote blobs from `staged/` to the space prefix.
5. If this is the first write into a space that is not the operator's, register it in the index as `pending`, initialise the space DO with `is_authority = 0`, then mark `active`.
6. Space DO `applyWrites` in one transaction. `RecordAlreadyExists` and `RecordNotFound` come back as typed errors.
7. Return the lexicon response.
8. In `waitUntil`: if the operator is the authority, call the space DO's `recordWriter(self, rev, hash)` and `enqueueNotify` for every registration; otherwise send `notifyWrite` to the authority.

Step 8's outbound call to a foreign authority resolves the authority's DID document, tries the `#atproto_space_host` service endpoint and falls back to `#atproto_pds`. The reference currently sends only to `#atproto_pds`; trying the dedicated entry first is what the proposal says and costs one extra lookup only for authorities that publish it. The service JWT has `iss` operator, `aud` the bare authority DID, `lxm` `com.atproto.space.notifyWrite`. One attempt, logged on failure. The proposal makes notifications best-effort and syncers self-healing, so a retry queue for the writer role is not worth its complexity. The authority role's fan-out does get a queue, below.

There is no membership check on writes to foreign spaces. The writer's PDS cannot know the member list. The authority applies its policy when the `notifyWrite` arrives and readers apply it when they assemble the view. This matches the reference.

### Read and sync path

`getRecord`, `listRecords`, `listBlobs`, `getLatestCommit`, `listRepoOps` and `getRepo` accept a space credential or a covering OAuth grant. All are served from the space DO with the Worker signing commits as needed.

`listRepoOps` follows the reference's cursor shape: `since` filters `rev > since`, `cursor` is `(rev, idx)`, and the signed commit is attached only on the page that reaches the head. If `since` predates the retained oplog window, the response starts from the oldest retained op with no error. The syncer's hash comparison at the head then fails and it falls back to full-state recovery, which is exactly the self-healing behaviour the proposal describes. No new error code is invented.

`getRepo` streams a CAR built with `serializeRepo` from `@atproto/space`. Records are pulled from the DO in pages over RPC. `serializeRepo` collects all records before writing, so the whole repo passes through Worker memory. That is acceptable for the alpha and for the personal-data and forum cases. A repo approaching the 128 MB Worker limit needs a streaming serialiser and is listed under open questions. `excludeValues` is cheap and unaffected.

### Space host role

Only for spaces whose authority is the operator DID.

`getSpaceCredential`: after delegation-token auth, load `config`. If the space is deleted, `SpaceDeleted`. If `appAccess` is `allowList`, require and verify a client attestation against the client's published JWKS, using the existing client resolver from the OAuth provider, and check the attested `client_id` against the list. Apply the user policy: `public` passes, `member-list` checks `member`, `managing-app` calls `checkUserAccess` on the managing app with a service JWT (`iss` operator, `aud` the managing app's service identifier). A timeout or error from the managing app denies. No decision caching in the alpha. On success, sign a credential with the account keypair, `cnf.jkt` from the DPoP proof, two-hour expiry.

`listRepos`: page the `writer` table with `rev` and `hash`.

`registerNotify` and `unregisterNotify`: space credential auth. Resolve the service identifier to an endpoint at registration time and store both, so fan-out does not resolve DIDs on every write. Registrations expire after seven days and the response says when.

`notifyWrite` inbound: service auth as above, then apply the same user policy used for credentials to the writer, record `(did, rev, hash)` in `writer`, enqueue fan-out to every registration except the sender.

Fan-out runs from the space DO's `notify_queue` on its alarm: bounded attempts with exponential backoff, then drop. Outbound fetch from a DO is fine here because this DO holds no WebSocket and does no storage-bound work that could be pinned by a slow request. The Worker only enqueues.

`simplespace` management methods gate on `manage` scopes or an operator session. `createSpace` writes the index entry, initialises the DO with `is_authority = 1` and the supplied policy and `appAccess`, then activates the index entry. `deleteSpace` marks the DO and index entry deleted, stops credential issuance, enqueues `notifySpaceDeleted` to every registration, deletes the operator's records and the space's R2 prefix. The DO is retained as a tombstone so a late `getSpaceCredential` gets `SpaceDeleted` rather than `SpaceNotFound`.

### User's PDS role

`getDelegationToken`: OAuth with a `read` grant covering the space, or an operator session. Mint a delegation JWT with the account keypair, `iss` operator, `sub` the space, `aud` `<authorityDid>#atproto_space_host`, sixty-second expiry. Stateless. Single use is enforced by the authority that receives it.

`listSpaces`: page the index DO, filterable by type and authority.

### Identity and discovery

When the flag is on, the did:web document adds a service entry `#atproto_space_host` pointing at the PDS origin. The verification method `#atproto_space` is not added. The proposal falls back to `#atproto` and the credential code in `@atproto/space` signs with `kid: #atproto` in that case. Adding a second key would create a rotation and backup story for no benefit on a single-user PDS.

When the flag is off, none of the space or simplespace routes are registered, so they fall through to the existing proxy behaviour and return `MethodNotImplemented` like any unknown method. The DID document, OAuth metadata and `describeServer` say nothing about spaces.

### Feature flag and reset

`SPACES_ENABLED` is a wrangler var, default unset. The template's `wrangler.jsonc` gains a `v2` migration adding `SpaceDurableObject` and `SpaceIndexDurableObject` as SQLite classes. Adding classes is an additive migration and is safe to ship to every install regardless of the flag.

`pds spaces reset` reads the index, calls `deleteAll()` on every space DO and the index DO, and deletes the `${did}/space/` R2 prefix. It does not touch `staged/`, `${did}/${cid}`, the account DO or OAuth state. It requires confirmation and prints what it is about to delete.

`pds spaces status` shows the flag, the schema version constant, the number of spaces by role and any `pending` or outdated entries.

### Dashboard and CLI

Dashboard: a Spaces tab listing spaces with role, type, skey, record count, member count for hosted spaces and a delete action. Member add and remove for hosted spaces. Nothing more in the alpha.

CLI: `pds spaces list`, `create`, `delete`, `members add|remove|list`, `export`, `reset`, `status`. All go through the Worker's authenticated RPC like the existing commands.

## Package layout

- **`@getcirrus/spaces`** – `SpaceDurableObject`, `SpaceIndexDurableObject`, the LtHash and commit handling wrapped from `@atproto/space`, credential and delegation verification helpers, DPoP replay helpers, blob key layout helpers, and a Hono route factory. The DO takes its authority DID, keypair provider, DID resolver, blob bucket and public origin from constructor configuration passed by the host Worker. It must not read `env.DID`. If it ever contains a branch on which host is running it, the boundary has failed.
- **`@getcirrus/pds`** – mounts the routes behind the flag, provides the account-specific pieces: `getDelegationToken`, `listSpaces`, the operator-session auth path, the DID document entry, dashboard and CLI.
- **`@getcirrus/oauth-provider`** – the scope changes.

Dependencies: `@atproto/space`, `@atproto/oauth-scopes` and `@atproto/syntax` pinned to exact alpha versions and excluded from Renovate. `@atproto/space` brings `@noble/hashes` for BLAKE3, which runs on Workers without native code, and `jose@5` alongside Cirrus's `jose@6`, which pnpm will keep separate. All three are re-verified against each Thursday build before bumping.

## Phasing

**Phase 0 – blob staging.** The R2 layout change and lifecycle rule, shipped alone with tests against the public path. Nothing behind the flag yet.

**Phase 1 – personal spaces (S1, S6, S7).** Both DO classes, the flag, `simplespace` with `member-list` and `public` policies, `createRecord` through `applyWrites`, `getRecord`, `listRecords`, `getBlob`, `listBlobs`, `getLatestCommit`, `getRepo`, `getSpaceCredential` without client attestation, `space:` scopes, reset and status. Enough to log in to bulletin.my. Interop test against the hosted alpha PDS's copy of the same app.

**Phase 2 – sync and foreign spaces (S2, S3, S4).** `getDelegationToken`, `listSpaces`, `listRepoOps` with compaction, writes into foreign spaces with `notifyWrite` out, `notifyWrite` in, `listRepos`, `registerNotify`, the fan-out queue. Cross-PDS tests against the reference alpha image and rsky.

**Phase 3 – policy and operations (S5, S8).** `managing-app` and `allowList`, client attestation, `deleteSpace` with `notifySpaceDeleted`, dashboard, export, `#atproto_space_host` in the DID document.

**Later.** Standalone host package (S9), streaming `getRepo`, blob cache tagging, rate limits per credential, import once the protocol defines it.

## Testing

- Unit tests under `@cloudflare/vitest-plugin` for the DO transaction, oplog compaction, LtHash round trips against `@atproto/space`'s own vectors, credential and delegation verification including replay, and the blob promotion copy.
- Conformance: the existing Cirrus PDS and OAuth-flow checks, extended with space methods. rsky reports running these already, so they double as a cross-implementation harness.
- Interop: a scripted flow against the reference alpha Docker image and against rsky covering S1 through S5, run before every alpha dependency bump.

## Open questions

- Whether `getDelegationToken` can be called by a confidential client with no browser session in the alpha SDK. Nothing in the lexicon prevents it, but the reference's `ACCESS_FULL` gate may in practice require an interactive OAuth grant.
- `serializeRepo` buffers the whole repo. A streaming variant needs either a two-pass DO read or a change upstream. Not needed for any story in this spec.
- The reference notifies authorities only at `#atproto_pds`. If a future build starts honouring `#atproto_space_host`, our outbound order already matches; if it never does, our DID document entry is harmless.
- Whether to accept `read_self`-only grants on `listRepoOps`. The reference allows it. It is consistent to allow it here, since all reads are self reads.
- Oplog retention defaults. Thirty days is a guess. bulletin.my's sync interval will tell us whether it matters.
- `jose@5` and `jose@6` side by side in a Worker bundle: functional, but worth checking the bundle size before the first release.
