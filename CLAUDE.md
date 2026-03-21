This file provides guidance to agentic coding tools when working with code in this repository.

## CRITICAL: Working Directory and Plan Document

**ALWAYS verify your current working directory before operating on files:**

- Repository root is `fidis` not `packages/pds/`
- Use `pwd` or check `process.cwd()` to confirm location
- Many project files (CLAUDE.md, plans/) are at repository root
- Package-specific files are in `packages/pds/`

**ALWAYS read and update implementation plans:**

- Plans are organized in the `plans/` directory at repository root:
  - `plans/complete/` - Completed features with full documentation
  - `plans/in-progress/` - Active development work
  - `plans/todo/` - Planned future features and improvements
- **Read** relevant plan documents before starting work to understand project status and prior decisions
- **Update** plan documents when you complete features, discover important implementation details, or change priorities
- Key plan documents:
  - `plans/complete/core-pds.md` - Core PDS implementation (all completed features)
  - `plans/todo/endpoint-implementation.md` - Endpoint implementation status and priorities
  - `plans/todo/oauth-provider.md` - OAuth 2.1 implementation plan
  - `plans/todo/migration-wizard.md` - Account migration UX specification

## System Architecture

### What This System Does

This codebase implements **WebFID** — a service that gives every Farcaster user an AT Protocol
identity (DID) and a Personal Data Server (PDS), derived from their Farcaster ID (FID).

For FID `NNN`:
- **DID**: `did:web:NNN.fid.is` — the user's AT Protocol identity
- **Handle**: `NNN.fid.is` — the user's AT Protocol handle
- **PDS hostname**: `NNN.fid.is` — the user's Personal Data Server

The DID and PDS share the same hostname. Cloudflare DNS routes all `*.fid.is` requests
to a single Worker. The Worker extracts the FID from the subdomain and routes to the
correct Durable Object.

### Two Distinct Functions Per Account

Each account provides two separable functions:

1. **DID Identity** — The `did:web:NNN.fid.is` document served at `/.well-known/did.json`.
   This advertises:
   - A verification key (`publicKeyMultibase`) — defaults to the account's own key
   - A PDS service endpoint — defaults to `https://NNN.fid.is`

   Users can override both to point to an external PDS (custom PDS URL + custom
   verification key), effectively using WebFID only as a DID provider.

2. **AT Protocol PDS** — A full PDS implementation supporting repo operations, firehose,
   blob storage, and federation with the Bluesky network. This is the `com.atproto.*`
   and `app.bsky.*` endpoint surface.

### Package Roles

- **`packages/pds`** — The core library. Contains the Worker entry point (`src/index.ts`),
  AccountDurableObject, all XRPC handlers, storage, and auth. This IS the PDS and DID
  provider.

- **`apps/fid-pds`** — Thin deployment wrapper. Re-exports `@fidis/pds` and provides
  `wrangler.jsonc` for deploying to Cloudflare. No application logic.

- **`apps/miniapp`** — Account management UI (React + Vite). Used to create accounts,
  configure DID settings (custom PDS URL, verification key), and manage PDS lifecycle.
  Runs as a Farcaster mini app or standalone web app via SIWF.

### API Endpoint Categories

All API calls MUST target the user's subdomain (`https://NNN.fid.is`), never the bare
domain (`https://fid.is`). Cloudflare routes all subdomains to the same Worker.

**Custom FID-PDS management endpoints (`is.fid.*`):**
These are NOT part of the AT Protocol spec. They manage account creation, auth, and settings.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST is.fid.account.createFarcasterMini` | Farcaster token | Create account |
| `POST is.fid.account.createSiwf` | SIWF signature | Create account (browser) |
| `POST is.fid.account.delete` | Bearer JWT | Delete account |
| `GET  is.fid.account.status` | None | Check account existence |
| `POST is.fid.auth.loginFarcasterMini` | Farcaster token | Login |
| `POST is.fid.auth.loginSiwf` | SIWF signature | Login (browser) |
| `POST is.fid.account.syncRelaySeq` | Bearer JWT | Debug: advance firehose seq |
| `GET  is.fid.settings.getPdsUrl` | Bearer JWT | Get DID/PDS config |
| `POST is.fid.settings.setPdsUrl` | Bearer JWT | Set custom PDS URL + key |

**AT Protocol PDS endpoints (`com.atproto.*`, `app.bsky.*`):**
Standard AT Protocol endpoints. Must conform to the AT Protocol specification.
These are what relays, AppViews, and Bluesky clients interact with.

**Experimental debug endpoints (`gg.mk.experimental.*`):**
Internal tools, not part of any spec. Used by the debug page in the miniapp.

## Repository Structure

This is a monorepo using pnpm workspaces with the following structure:

- **Root** (`fidis`): Workspace configuration, shared tooling, plan documents
- **packages/pds**: The main PDS library (`@fidis/pds`)
- **packages/oauth-provider**: OAuth 2.1 Provider (`@fidis/oauth-provider`)
- **packages/create-pds**: CLI scaffolding tool (`create-pds`)
- **demos/pds**: Demo PDS deployment

## Commands

### Root-level commands (run from repository root):

- `pnpm build` - Build all packages
- `pnpm test` - Run tests for all packages
- `pnpm check` - Run type checking and linting for all packages
- `pnpm format` - Format code using Prettier

### Package-level commands (run within individual packages):

- `pnpm build` - Build the package using tsdown (ESM + DTS output)
- `pnpm dev` - Watch mode for development
- `pnpm test` - Run vitest tests
- `pnpm check` - Run publint and @arethetypeswrong/cli checks

## Development Workflow

- Uses **pnpm** as package manager
- **tsdown** for building TypeScript packages with ESM output and declaration files
- **vitest** for testing
- **publint** and **@arethetypeswrong/cli** for package validation
- **Prettier** for code formatting (configured to use tabs in `.prettierrc`)

## Package Architecture

Each package in `packages/` follows this structure:

- `src/index.ts` - Main entry point
- `test/` - Test files
- `dist/` - Built output (ESM + .d.ts files)
- Package exports configured for ESM-only with proper TypeScript declarations

## TypeScript Configuration

Uses strict TypeScript configuration with:

- Target: ES2022
- Module: preserve (for bundler compatibility)
- Strict mode with additional safety checks (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- Library-focused settings (declaration files, declaration maps)

## PDS Package Specifics

### Testing with Cloudflare Workers

The PDS package uses **vitest 3.2.x** with `@cloudflare/vitest-pool-workers@0.12.x`:

- Test configuration in `vitest.config.ts` using `defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config`
- Pool options: `singleWorker: true` for Durable Object testing
- Module bundling: `deps.optimizer.ssr.include` bundles `multiformats`, `@atproto/*`, `@ipld/*` etc. for workerd compatibility
- Test environment bindings configured in `vitest.config.ts` via `poolOptions.workers.miniflare.bindings`
- Use `cloudflare:test` module for `env` and `runInDurableObject` helpers
- Use `cloudflare:workers` module for type imports like `DurableObject`, `Env`
- Shared test helpers in `test/helpers.ts`: `seedIdentity()`, `getTestAccountStub()`, `createTestAccessToken()`, `testUrl()`
- Tests use FID-derived identity (`TEST_FID=12345`, `TEST_DID=did:web:12345.fid.test`, `TEST_HANDLE=12345.fid.test`)
- DO-internal tests: use `runInDurableObject(stub, async (instance) => { await seedIdentity(instance); ... })`
- HTTP tests: use `createTestAccessToken()` for JWT auth, `testUrl("/xrpc/...")` for correct subdomain hostname

### TypeScript Module Resolution

The PDS package TypeScript configuration:

1. **Module Resolution**: Uses `moduleResolution: "bundler"` in tsconfig.json
2. **Test Types**: `test/tsconfig.json` includes `@cloudflare/vitest-pool-workers/types` for cloudflare:test module
3. **Import Style**: Use named imports (not namespace imports) for `verbatimModuleSyntax` compatibility

### Durable Objects Architecture

- **Worker** (stateless): Routing, authentication, DID document serving, FID-based DO routing
- **AccountDurableObject** (stateful): Repository operations, SQLite storage, firehose, account lifecycle
- **RPC Pattern**: Use DO RPC methods (compatibility date >= 2024-04-03), not fetch handlers
- **RPC Types**: Return types must use `Rpc.Serializable<T>` for proper type inference
- **Error Handling**: Let errors propagate naturally, create fresh DO stubs per request
- **Initialization**: Use lazy initialization with `blockConcurrencyWhile` for storage and repo setup
- **Account Lifecycle RPCs**: `rpcGetAccountStatus()`, `rpcEmitAccountEvent()`, `rpcActivateAccount()`, `rpcDeactivateAccount()`, `rpcDeleteAccount()`, `rpcRecreateAccount()`

### Environment Variables

The PDS supports two deployment modes with different environment variables:

**Multi-tenant mode (FID-based):**

- `WEBFID_DOMAIN` - Base domain for FID subdomains (e.g., `fid.is`)
- `QUICKAUTH_DOMAIN` - Management subdomain for Farcaster Quick Auth (e.g., `my.fid.is`)
- `JWT_SECRET` - Secret for signing session JWTs
- `INITIAL_ACTIVE` - Whether new accounts start active (default: `true`)

**Single-tenant mode (legacy):**

- `DID` - The account's DID (did:web:...) - validated with `isDid()`
- `HANDLE` - The account's handle - validated with `isHandle()`
- `PDS_HOSTNAME` - Public hostname
- `AUTH_TOKEN` - Bearer token for write operations (simple auth)
- `SIGNING_KEY` - Private key for signing commits
- `SIGNING_KEY_PUBLIC` - Public key multibase for DID document
- `JWT_SECRET` - Secret for signing session JWTs (optional)
- `PASSWORD_HASH` - Bcrypt hash of account password (optional)

**Bindings (both modes):**

- `ACCOUNT` - DurableObjectNamespace for AccountDurableObject
- `BLOBS` - R2 bucket binding for blob storage
- `USER_REGISTRY` - D1 database for FID-to-DID registry (multi-tenant only)

### Protocol Helpers and Dependencies

**CRITICAL: Prefer @atcute packages over @atproto where available.**

The codebase uses @atcute packages for most protocol operations, with @atproto packages only where no equivalent exists.

**@atcute packages (preferred):**

- `@atcute/cbor` - CBOR encoding/decoding (via `src/cbor-compat.ts` compatibility layer)
- `@atcute/cid` - CID creation with `create()`, `toString()`, `CODEC_RAW`
- `@atcute/tid` - TID generation with `now()`
- `@atcute/lexicons/syntax` - `isDid()`, `isHandle()`, `parseResourceUri()`, `Did` type
- `@atcute/lexicons/validations` - `parse()`, `ValidationError` for schema validation
- `@atcute/bluesky` - Pre-compiled Bluesky lexicon schemas (e.g., `AppBskyFeedPost.mainSchema`)
- `@atcute/identity` - `defs.didDocument` validator, `DidDocument` type, `getAtprotoServiceEndpoint()`
- `@atcute/identity-resolver` - DID resolution (`CompositeDidDocumentResolver`, `PlcDidDocumentResolver`, `WebDidDocumentResolver`), handle resolution (`DohJsonHandleResolver`)
- `@atcute/client` - Type-safe XRPC client with `get()`, `post()`, `ok()` helper
- `@atcute/atproto` - Type definitions for `com.atproto.*` endpoints

**@atproto packages (required for repo operations):**

- `@atproto/repo` - Repository operations, `BlockMap`, `blocksToCarFile()`, `readCarWithRoot()` - no atcute equivalent for write operations
- `@atproto/crypto` - `Secp256k1Keypair` for signing - required by @atproto/repo
- `@atproto/lex-data` - `CID`, `asCid()`, `isBlobRef()` - required for @atproto/repo interop

**Important Notes:**

- Construct AT URIs with template strings: `` `at://${did}/${collection}/${rkey}` ``
- Generate record keys with `now()` from `@atcute/tid`
- Validate DIDs/handles with `isDid()` / `isHandle()` (return boolean, don't throw)
- Parse AT URIs with `parseResourceUri()` which returns a Result object
- Use `create(CODEC_RAW, bytes)` from `@atcute/cid` for blob CID generation
- CBOR encoding uses `src/cbor-compat.ts` which wraps @atcute/cbor for @atproto interop
- CAR file export uses `blocksToCarFile()` from `@atproto/repo`

### Vitest Configuration Notes

- **Module Bundling**: Uses `deps.optimizer.ssr.include` to bundle multiformats and @atproto packages for workerd compatibility
- **BlockMap/CidSet**: Access internal Map/Set via `(blocks as unknown as { map: Map<...> }).map` when iterating
- **Test Count**: 79 unit tests across 9 active test files (8 skipped pending multi-tenant migration), 84 CLI tests across 5 test files

### Firehose Implementation

The PDS implements the WebSocket-based firehose for real-time federation:

- **Sequencer**: Manages event log in `firehose_events` SQLite table
- **WebSocket Hibernation API**: DurableObject WebSocket handlers (message, close, error)
- **Frame Encoding**: DAG-CBOR frame encoding (header + body concatenation)
- **Event Broadcasting**: Automatic sequencing and broadcast on write operations
- **Cursor-based Backfill**: Replay events from sequence number with validation
- **Error Frames**: Spec-compliant error frame (op: -1) for future cursors, then close

**Event Types:**

- `#commit` — Record create/update/delete operations (includes CAR blocks)
- `#identity` — Handle or DID document changes
- `#account` — Account lifecycle changes (activation, deactivation, deletion)

**Event Flow:**

1. `createRecord`/`deleteRecord` → sequence `#commit` to SQLite
2. `rpcEmitIdentityEvent()` → sequence `#identity` to SQLite
3. `rpcEmitAccountEvent()` → sequence `#account` to SQLite
4. Broadcast CBOR-encoded frame to all connected WebSocket clients
5. Update client cursor positions in WebSocket attachments

**Endpoint:**

- `GET /xrpc/com.atproto.sync.subscribeRepos?cursor={seq}` - WebSocket upgrade for event stream

### Lexicon Validation

Records are validated against official Bluesky lexicon schemas from `@atcute/bluesky`:

- **RecordValidator**: Class in `src/validation.ts` for record validation
- **Pre-compiled Schemas**: Uses `@atcute/bluesky` package (e.g., `AppBskyFeedPost.mainSchema`)
- **Optimistic Validation**: Fail-open for unknown schemas - records with no loaded schema are accepted
- **Schema Validation**: Uses `parse()` from `@atcute/lexicons/validations`

**Usage:**

```ts
import { validator } from "./validation";
validator.validateRecord("app.bsky.feed.post", record); // throws on invalid
```

**Adding New Record Types:**

Import the schema from `@atcute/bluesky` and add to `recordSchemas` map in `validation.ts`.

### Session Authentication

JWT-based session authentication for Bluesky app compatibility:

- **Access Tokens**: Short-lived JWTs for API requests (60 min expiry)
- **Refresh Tokens**: Long-lived JWTs for session refresh (90 day expiry)
- **Password Auth**: `verifyPassword()` using bcrypt-compatible hashing
- **Static Token**: `AUTH_TOKEN` env var still supported for simple auth

**Required Environment Variables:**

- `JWT_SECRET` - Secret for signing JWTs
- `PASSWORD_HASH` - Bcrypt hash of account password (for app login)

### Service Auth for AppView Proxy

The PDS proxies unknown XRPC methods to the Bluesky AppView:

- **Service JWT**: `createServiceJwt()` in `src/service-auth.ts`
- **Audience**: `did:web:api.bsky.app` (the AppView)
- **Issuer**: User's DID (the PDS vouches for the user)
- **LXM Claim**: Lexicon method being called (for authorization scoping)

**Flow:**

1. Client requests unknown XRPC method
2. PDS creates service JWT asserting user identity
3. Request proxied to AppView with `Authorization: Bearer <service-jwt>`
4. AppView trusts the PDS's assertion

### Account Migration

Support for importing repositories via CAR file:

- **Import Endpoint**: `com.atproto.repo.importRepo` accepts CAR file upload
- **Account Status**: `com.atproto.server.getAccountStatus` returns migration state
- **CAR Parsing**: Uses `readCarWithRoot()` from `@atproto/repo`
- **Validation**: Verifies root CID and block integrity during import

**Import Flow:**

1. Export CAR from source PDS
2. POST CAR bytes to `/xrpc/com.atproto.repo.importRepo`
3. PDS validates and imports all blocks
4. Repository initialized with imported state

### Account Lifecycle

Accounts have a `status` field in `repo_state` that controls behavior:

| Status | Reads | Writes | Firehose | Reversible |
|--------|-------|--------|----------|------------|
| `active` | yes | yes | live events | — |
| `deactivated` | yes | no | `#account` event | yes |
| `deleted` | no (tombstone only) | no | `#account` tombstone | no (re-creation possible) |

**Key RPC methods on AccountDurableObject:**

- `rpcGetAccountStatus()` — returns `"active"` / `"deactivated"` / `"deleted"` / `null`
- `rpcEmitAccountEvent(active, status?)` — sequences and broadcasts `#account` event
- `rpcActivateAccount()` / `rpcDeactivateAccount()` — state transitions with `#account` events
- `rpcDeleteAccount()` — tombstone-preserving deletion (targeted SQL DELETEs, not `deleteAll()`)
- `rpcRecreateAccount()` — re-creates an account after deletion (new keys, fresh identity)

**Deletion flow:**

1. Emit `#account` event (`active: false, status: "deleted"`)
2. Broadcast to all connected WebSocket clients, then close connections
3. Delete R2 blobs
4. Targeted SQL DELETEs (blocks, records, blobs, passkeys, preferences)
5. Clear signing keys (retain DID + handle for tombstone)
6. Delete all firehose events except the tombstone
7. Clear OAuth storage

**Deleted account behavior:**

- Firehose reconnections receive the `#account` tombstone event, then connection closes
- `listRepos` returns empty `repos: []` with `active: false, status: "deleted"`
- `/.well-known/did.json` returns 404
- Write operations return HTTP 410 (Gone)
- Account can be re-created via Farcaster Quick Auth (generates new keys)

**Storage layer:**

- `storage.getStatus()` / `storage.setStatus()` — read/write the `status` column
- `storage.clearBulkData()` — targeted deletion of blocks, records, blobs, passkeys, preferences
- `storage.clearSigningKeys()` — blanks keys while preserving DID + handle
- Schema migration auto-adds `status` column and backfills from legacy `active` boolean

### Request Routing

Cloudflare DNS routes `*.fid.is` to a single Worker. The Worker extracts the FID from
the request hostname subdomain, derives the DID (`did:web:NNN.fid.is`), and gets the
AccountDurableObject via `env.ACCOUNT.idFromName(did)`.

**Important:** All API requests from the miniapp must use `https://NNN.fid.is` as the
base URL, constructed from the user's FID or handle after authentication. The bare domain
`https://fid.is` should never be used as an API base — it exists only for the homepage
and DNS routing.

**Account creation endpoints:**

- `POST /xrpc/is.fid.account.createFarcasterMini` — create with Farcaster Quick Auth token
- `POST /xrpc/is.fid.account.createSiwf` — create with Sign-In-With-Farcaster
- `POST /xrpc/is.fid.auth.loginFarcasterMini` / `loginSiwf` — login endpoints
- `POST /xrpc/is.fid.account.delete` — delete account (tombstone-preserving)
