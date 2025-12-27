This file provides guidance to agentic coding tools when working with code in this repository.

## CRITICAL: Working Directory and Plan Document

**ALWAYS verify your current working directory before operating on files:**

- Repository root is `atproto-worker` not `packages/pds/`
- Use `pwd` or check `process.cwd()` to confirm location
- Many project files (CLAUDE.md, EDGE_PDS_PLAN.md) are at repository root
- Package-specific files are in `packages/pds/`

**ALWAYS read and update the implementation plan:**

- **Read** `EDGE_PDS_PLAN.md` at the repository root before starting work to understand project status
- **Update** `EDGE_PDS_PLAN.md` when you complete phases or discover important implementation details
- The plan tracks what's completed, what's pending, and critical technical notes
- Keep the "Completed" section updated with new learnings (WebSocket patterns, CBOR encoding, etc.)

## Repository Structure

This is a monorepo using pnpm workspaces with the following structure:

- **Root** (`atproto-worker`): Workspace configuration, shared tooling, plan documents
- **packages/pds**: The main PDS library (`@ascorbic/pds-worker`)
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

The PDS package uses **vitest 4** with `@cloudflare/vitest-pool-workers` PR build (#11632):

- Test configuration in `vitest.config.ts` using `cloudflareTest` plugin
- Pool options: `maxWorkers: 1` and `isolate: false` for Durable Object testing
- Test environment bindings configured in `.dev.vars` (not checked into git)
- Use `cloudflare:test` module for `env` and `runInDurableObject` helpers
- Use `cloudflare:workers` module for type imports like `DurableObject`, `Env`

### TypeScript Module Resolution

The PDS package TypeScript configuration:

1. **Module Resolution**: Uses `moduleResolution: "bundler"` in tsconfig.json
2. **Test Types**: `test/tsconfig.json` includes `@cloudflare/vitest-pool-workers/types` for cloudflare:test module
3. **Import Style**: Use named imports (not namespace imports) for `verbatimModuleSyntax` compatibility

### Durable Objects Architecture

- **Worker** (stateless): Routing, authentication, DID document serving
- **AccountDurableObject** (stateful): Repository operations, SQLite storage
- **RPC Pattern**: Use DO RPC methods (compatibility date >= 2024-04-03), not fetch handlers
- **RPC Types**: Return types must use `Rpc.Serializable<T>` for proper type inference
- **Error Handling**: Let errors propagate naturally, create fresh DO stubs per request
- **Initialization**: Use lazy initialization with `blockConcurrencyWhile` for storage and repo setup

### Environment Variables

Required environment variables (validated at module load using `cloudflare:workers` env import):

- `DID` - The account's DID (did:web:...) - validated with `ensureValidDid()`
- `HANDLE` - The account's handle - validated with `ensureValidHandle()`
- `PDS_HOSTNAME` - Public hostname
- `AUTH_TOKEN` - Bearer token for write operations
- `SIGNING_KEY` - Private key for signing commits
- `SIGNING_KEY_PUBLIC` - Public key multibase for DID document

**Note**: Environment validation happens at module scope. Worker fails fast at startup if any required variables are missing or invalid.

### Protocol Helpers and Dependencies

**CRITICAL: Always use @atproto libraries instead of low-level dependencies where available.**

The codebase uses official @atproto packages for all protocol operations. When implementing new features:

- **Always prefer @atproto packages** over direct use of `multiformats`, `uint8arrays`, `cborg`, etc.
- **Reference the atproto monorepo** at `~/Repos/atproto` to understand available functions and patterns
- The @atproto packages provide stable, tested abstractions over low-level primitives

**Encoding and Data Structures:**

- `@atproto/lex-cbor` - CBOR encoding/decoding with `encode()`, `cidForCbor()`, `cidForRawBytes()`
- `@atproto/lex-data` - CID operations via stable interface wrapping multiformats
- `@atproto/repo` - Repository operations, `BlockMap`, `blocksToCarFile()`

**Protocol Utilities:**

- `@atproto/common-web` - `TID.nextStr()` for record key generation
- `@atproto/syntax` - `AtUri.make()`, `ensureValidDid()`, `ensureValidHandle()`
- `@atproto/crypto` - `Secp256k1Keypair` for signing operations, `sha256()` for hashing
- `@atproto/lexicon` - Schema validation and type definitions

**Important Notes:**

- Never manually construct AT URIs - use `AtUri.make(did, collection, rkey).toString()`
- Never manually generate record keys - use `TID.nextStr()`
- Always validate DIDs and handles using `ensureValidDid()` / `ensureValidHandle()`
- Use `cidForRawBytes()` from `@atproto/lex-cbor` for blob CID generation
- Use `@atproto/lex-cbor` for test fixtures instead of direct `@ipld/dag-cbor`
- CAR file export uses `blocksToCarFile()` from `@atproto/repo`

### Vitest Configuration Notes

- **Module Shimming**: Uses `resolve: { conditions: ["node", "require"] }` to force CJS builds for multiformats
- **BlockMap/CidSet**: Access internal Map/Set via `(blocks as unknown as { map: Map<...> }).map` when iterating
- **Test Count**: 58 tests (16 storage tests, 26 XRPC tests, 6 firehose tests, 10 blob tests)

### Firehose Implementation

The PDS implements the WebSocket-based firehose for real-time federation:

- **Sequencer**: Manages commit event log in `firehose_events` SQLite table
- **WebSocket Hibernation API**: DurableObject WebSocket handlers (message, close, error)
- **Frame Encoding**: DAG-CBOR frame encoding (header + body concatenation)
- **Event Broadcasting**: Automatic sequencing and broadcast on write operations
- **Cursor-based Backfill**: Replay events from sequence number with validation

**Event Flow:**

1. `createRecord`/`deleteRecord` → sequence commit to SQLite
2. Broadcast CBOR-encoded frame to all connected WebSocket clients
3. Update client cursor positions in WebSocket attachments

**Endpoint:**

- `GET /xrpc/com.atproto.sync.subscribeRepos?cursor={seq}` - WebSocket upgrade for commit stream
