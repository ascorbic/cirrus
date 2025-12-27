This file provides guidance to agentic coding tools when working with code in this repository.

## Repository Structure

This is a monorepo using pnpm workspaces with the following structure:

- **Root**: Workspace configuration and shared tooling
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

The PDS package requires special handling for certain dependencies:

1. **Module Resolution**: Uses `moduleResolution: "bundler"` in tsconfig.json
2. **Custom Type Declarations**: `src/types/modules.d.ts` provides declarations for packages with broken exports:
   - `multiformats/cid`
   - `@ipld/dag-cbor`
   - `uint8arrays`
   - `multiformats/hashes/sha2`
3. **Test Types**: `test/tsconfig.json` includes `@cloudflare/vitest-pool-workers/types` for cloudflare:test module
4. **Import Style**: Use named imports (not namespace imports) for `verbatimModuleSyntax` compatibility

### Durable Objects Architecture

- **Worker** (stateless): Routing, authentication, DID document serving
- **AccountDurableObject** (stateful): Repository operations, SQLite storage
- **RPC Pattern**: Use DO RPC methods (compatibility date >= 2024-04-03), not fetch handlers
- **RPC Types**: Return types must use `Rpc.Serializable<T>` for proper type inference
- **Error Handling**: Let errors propagate naturally, create fresh DO stubs per request
- **Initialization**: Use lazy initialization with `blockConcurrencyWhile` for storage and repo setup

### Environment Variables

Required environment variables (validated at startup):
- `DID` - The account's DID (did:web:...)
- `HANDLE` - The account's handle
- `PDS_HOSTNAME` - Public hostname
- `AUTH_TOKEN` - Bearer token for write operations
- `SIGNING_KEY` - Private key for signing commits
- `SIGNING_KEY_PUBLIC` - Public key multibase for DID document

### Vitest Configuration Notes

- **Module Shimming**: Uses `resolve: { conditions: ["node", "require"] }` to force CJS builds for multiformats
- **CID Deprecation**: Ignore `'CID' is deprecated` warnings - false positive from multiformats types
- **BlockMap/CidSet**: Access internal Map/Set via `(blocks as unknown as { map: Map<...> }).map` when iterating
