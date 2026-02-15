# Core PDS Implementation

**Status:** ✅ Complete

## Overview

A single-user AT Protocol Personal Data Server (PDS) implemented on Cloudflare Workers with Durable Objects. The PDS federates with the Bluesky network – the relay can sync from it, and AppViews can read from it.

**Live at:** https://pds.mk.gg

## Implemented Features

### Storage Layer (Phase 1)

- ✅ `SqliteRepoStorage` implementing `@atproto/repo` RepoStorage interface
- ✅ SQLite schema for blocks, repo state, and firehose events
- ✅ Atomic commit operations with transaction support

### Durable Object Architecture (Phase 2)

- ✅ `AccountDurableObject` with Repo integration
- ✅ Lazy initialization with `blockConcurrencyWhile`
- ✅ RPC-first architecture following DO best practices
- ✅ Signing key import from environment with validation

### XRPC Endpoints (Phase 3)

- ✅ Sync endpoints: `getRepo`, `getRepoStatus`, `subscribeRepos`
- ✅ Repository operations: `describeRepo`, `getRecord`, `listRecords`, `createRecord`, `deleteRecord`, `putRecord`, `applyWrites`
- ✅ Server identity: `describeServer`, `resolveHandle`
- ✅ Blob operations: `uploadBlob`, `getBlob`, `listBlobs`
- ✅ Session management: `createSession`, `refreshSession`, `getSession`, `deleteSession`
- ✅ Migration: `importRepo`, `getAccountStatus`
- ✅ Service auth: `getServiceAuth`
- ✅ Preferences: `getPreferences`, `putPreferences`

### Firehose Implementation (Phase 4)

- ✅ WebSocket hibernation API handlers
- ✅ DAG-CBOR frame encoding using `@atproto/lex-cbor`
- ✅ Event broadcasting to connected clients
- ✅ Cursor-based backfill and validation
- ✅ Sequencer class for commit event log management
- ✅ SQLite `firehose_events` table with automatic pruning

### Blob Storage (Phase 5)

- ✅ R2 integration with `BlobStore` class
- ✅ CID generation using `cidForRawBytes()` from `@atproto/lex-cbor`
- ✅ 5MB upload limit enforcement
- ✅ Direct R2 access in endpoints

### Identity & DID Documents (Phase 6)

- ✅ DID document served at `/.well-known/did.json`
- ✅ Handle verification at `/.well-known/atproto-did`
- ✅ Support for both did:web and did:plc identifiers

### Authentication (Phase 7)

- ✅ Bearer token middleware for write endpoints
- ✅ Static token auth (AUTH_TOKEN)
- ✅ JWT-based session authentication
- ✅ bcrypt password hashing
- ✅ Access token + refresh token flow

### Session Authentication (Phase 8)

- ✅ JWT signing with HS256 (using jose library)
- ✅ 60-minute access tokens, 90-day refresh tokens
- ✅ Compatible with Bluesky app authentication
- ✅ Password verification with bcryptjs

### Lexicon Validation (Phase 8)

- ✅ `RecordValidator` class using `@atproto/lexicon`
- ✅ Optimistic validation strategy (fail-open)
- ✅ Dynamic schema loading via Vite glob imports
- ✅ Validation integrated into mutation endpoints

### Account Migration (Phase 9)

- ✅ CAR file import using `readCarWithRoot()`
- ✅ Export/import workflow with validation
- ✅ DID matching verification
- ✅ Prevention of overwrites

### Protocol Helpers

- ✅ All operations use official @atproto utilities
- ✅ TID generation via `TID.nextStr()`
- ✅ AT-URI construction via `AtUri.make()`
- ✅ DID/Handle validation
- ✅ CBOR encoding via `@atproto/lex-cbor`
- ✅ CAR export via `blocksToCarFile()`

### CLI Setup Wizard

- ✅ `pds init` - Interactive setup for production
- ✅ `pds init --local` - Setup for local development
- ✅ Secret management commands
- ✅ Integration with wrangler config

### Testing

- ✅ 140+ tests covering all features
- ✅ Vitest 4 with Cloudflare Workers pool
- ✅ Durable Object testing support
- ✅ Integration tests for federation

### DID Resolution & XRPC Proxy

- ✅ Full DID resolver for did:web and did:plc
- ✅ DID caching with stale-while-revalidate
- ✅ XRPC proxy with atproto-proxy header support
- ✅ Service discovery and routing

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                              │
│                                                                  │
│  ┌──────────────┐         ┌─────────────────────────────────┐   │
│  │    Worker    │────────▶│      Account Durable Object     │   │
│  │  (stateless) │         │        (single instance)        │   │
│  │              │         │                                 │   │
│  │ • Routing    │         │ • Repository (via @atproto/repo)│   │
│  │ • Auth       │         │ • SQLite storage                │   │
│  │ • DID doc    │         │ • Firehose (WebSocket)          │   │
│  └──────────────┘         └─────────────────────────────────┘   │
│         │                              │                         │
│         ▼                              ▼                         │
│  ┌──────────────┐         ┌─────────────────────────────────┐   │
│  │      R2      │         │         DO SQLite               │   │
│  │   (blobs)    │         │  (blocks, records, commits)     │   │
│  └──────────────┘         └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

- `PDS_HOSTNAME` - Public hostname of the PDS
- `HANDLE` - Account handle
- `DID` - Account DID
- `SIGNING_KEY_PUBLIC` - Public key for DID document

### Secrets

- `SIGNING_KEY` - Private signing key (secp256k1)
- `AUTH_TOKEN` - Bearer token for API access
- `JWT_SECRET` - Secret for JWT signing
- `PASSWORD_HASH` - bcrypt password hash

### Bindings

- `ACCOUNT` - DurableObjectNamespace
- `BLOBS` - R2Bucket

## Dependencies

All dependencies are Workers-compatible:

- `@atproto/repo` - Core MST and repository operations
- `@atproto/crypto` - Cryptographic operations
- `@atproto/syntax` - Protocol utilities
- `@atproto/lexicon` - Schema validation
- `@atproto/lex-cbor` - CBOR encoding
- `@atproto/common-web` - Common utilities
- `hono` - HTTP router
- `jose` - JWT operations
- `bcryptjs` - Password hashing

## Test Coverage

- 16 storage tests
- 32 XRPC tests
- 8 firehose tests
- 10 blob tests
- 15 session tests
- 8 validation tests
- 9 migration tests
- 11 Bluesky validation tests
- 3 service-auth tests
- 28 CLI tests

**Total: 140 tests, all passing**

## Key Technical Decisions

1. **Workers-native**: Built specifically for Cloudflare Workers, not a port
2. **Single-user**: Simplified auth and account management
3. **Official libraries**: Uses @atproto packages for all protocol operations
4. **RPC-first DO**: Durable Object exposes RPC methods, not fetch handlers
5. **WebSocket hibernation**: Leverages Workers-specific WebSocket API
6. **Zero-code deployment**: Users re-export package, no custom code needed

## Performance

- CAR export: ~100ms for typical repo
- Record operations: <10ms
- Firehose latency: <50ms
- Blob uploads: Streaming to R2, no memory buffering

## Limitations

- Single user only (by design)
- No email verification
- No OAuth provider (planned)
- No did:plc migration (partial support - see todo plans)
- No rate limiting (not needed for single-user)

## References

- [AT Protocol Specs](https://atproto.com/specs)
- [Bluesky PDS Reference](https://github.com/bluesky-social/atproto/tree/main/packages/pds)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
