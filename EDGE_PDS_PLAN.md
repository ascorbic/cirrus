# Edge PDS Implementation Plan

## Goal

Build a single-user AT Protocol Personal Data Server (PDS) on Cloudflare Workers with Durable Objects. The PDS will federate with the Bluesky network – the relay can sync from it, and AppViews can read from it.

**Scope:** Single-user only. No account creation, no multi-tenancy. The owner's DID and signing key are configured at deploy time.

---

## Current Status

**Live at: https://pds.mk.gg**

### Completed (Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 6 + Phase 7)

- ✅ **Storage Layer** (Phase 1) - `SqliteRepoStorage` implementing `@atproto/repo` RepoStorage interface
- ✅ **Durable Object** (Phase 2) - `AccountDurableObject` with Repo integration
  - SQLite schema initialization
  - Lazy loading of Repo from storage
  - Signing key import from environment with validation
  - Create new repo if none exists, load existing repo otherwise
  - RPC-first architecture following DO best practices
- ✅ **XRPC Endpoints** (Phase 3) - Full router implementation with Hono
  - Tier 1: Sync endpoints (`com.atproto.sync.getRepo`, `com.atproto.sync.getRepoStatus`, `com.atproto.sync.subscribeRepos`)
  - Tier 2: Repository operations (`com.atproto.repo.{describeRepo,getRecord,listRecords,createRecord,deleteRecord}`)
  - Tier 3: Server identity (`com.atproto.server.describeServer`, `com.atproto.identity.resolveHandle`)
- ✅ **Firehose** (Phase 4) - WebSocket subscribeRepos event stream
  - Sequencer class for commit event log management
  - WebSocket hibernation API handlers (message, close, error)
  - DAG-CBOR frame encoding (header + body)
  - Event broadcasting to connected clients
  - Cursor-based backfill and validation
  - SQLite `firehose_events` table for event persistence
- ✅ **DID Document** (Phase 6) - Served at `/.well-known/did.json` for did:web resolution
- ✅ **Authentication** (Phase 7) - Bearer token middleware for write endpoints
- ✅ **Health Check** - `/health` endpoint with version info
- ✅ **Deployment** - Custom domain `pds.mk.gg` with auto-provisioned DNS
- ✅ **Signing Keys** - secp256k1 keypair generated and configured
- ✅ **Environment Validation** - Module-scope validation using `cloudflare:workers` env import
- ✅ **Testing** - Migrated to vitest 4, all 48 tests passing
  - 16 storage tests
  - 26 XRPC tests (auth, concurrency, error handling, CAR validation)
  - 6 firehose tests (event sequencing, cursor validation, backfill)
- ✅ **TypeScript** - All diagnostic errors resolved, proper type declarations for cloudflare:test
- ✅ **Protocol Helpers** - All protocol operations use official @atproto utilities
  - Record keys: `TID.nextStr()` from `@atproto/common-web`
  - AT URI construction: `AtUri.make()` from `@atproto/syntax`
  - DID validation: `ensureValidDid()` from `@atproto/syntax`
  - Handle validation: `ensureValidHandle()` from `@atproto/syntax`
  - CBOR encoding: `@atproto/lex-cbor`
  - CAR export: `blocksToCarFile()` from `@atproto/repo`
- ✅ **Dependency Optimization** - Removed 6 low-level dependencies, added 3 @atproto helpers
  - Removed: `varint`, `@types/varint`, `cborg`, `uint8arrays`, `@ipld/dag-cbor`, `multiformats`
  - Added: `@atproto/lex-data`, `@atproto/lex-cbor`, `@atproto/common-web`
  - Net reduction: 116 lines, better standards compliance

### Not Started

- ⬜ **Blob Storage** (Phase 5) - R2 integration (R2 needs enabling in dashboard)

### Testing & Development Notes

**Vitest 4 Migration**: Successfully migrated to vitest 4 with `@cloudflare/vitest-pool-workers` PR build (#11632). This required:
- Updating config format from `defineWorkersConfig` to `defineConfig` with `cloudflareTest` plugin
- Moving pool options to top-level test config
- Setting `maxWorkers: 1` and `isolate: false` for Durable Object testing

**CJS/ESM Module Resolution**: Fixed module shimming issues with `@atproto/*` packages by adding `resolve: { conditions: ["node", "require"] }` to vitest config. This forces Vite to use the actual CJS builds provided by `multiformats` instead of attempting to shim ESM builds.

**BlockMap/CidSet Iteration**: Access internal Map/Set properties directly when iterating:
```typescript
// Instead of: for (const [cid, bytes] of blocks) { ... }
const internalMap = (blocks as unknown as { map: Map<string, Uint8Array> }).map
for (const [cidStr, bytes] of internalMap) { ... }
```

**TypeScript Module Resolution**: Fixed module resolution for packages with broken exports (`multiformats`, `@ipld/dag-cbor`, `uint8arrays`) by:
- Adding `moduleResolution: "bundler"` to tsconfig.json
- Creating `src/types/modules.d.ts` with custom type declarations for problematic packages
- Using `verbatimModuleSyntax` compatible imports (named imports instead of namespace imports)
- Adding `@cloudflare/vitest-pool-workers/types` to test tsconfig for cloudflare:test module

**Durable Object RPC Types**: Using `Rpc.Serializable<any>` for RPC method return types to ensure TypeScript correctly infers serializable types instead of `never`.

---

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

---

## Build vs Buy Analysis

### Components We Will USE (Buy/Reuse)

| Component | Package | Rationale |
|-----------|---------|-----------|
| MST & Repo Operations | `@atproto/repo` | Core protocol logic, well-tested, handles commits, MST updates, CAR export |
| Cryptographic Operations | `@atproto/crypto` | Signing, verification, did:key - critical to get right |
| Protocol Utilities | `@atproto/syntax` | TID generation, AT-URI parsing, DID/handle validation |
| Schema Validation | `@atproto/lexicon` | Record type validation |
| CBOR Encoding | `@atproto/lex-cbor` | Official AT Protocol CBOR utilities, Workers-compatible |
| CID Operations | `@atproto/lex-data` | Stable CID interface wrapping multiformats |
| Common Utilities | `@atproto/common-web` | TID generation, timestamp utilities |

### Components We Will BUILD

| Component | Rationale |
|-----------|-----------|
| Storage Adapter | Must implement `RepoStorage` interface for DO SQLite - ~100 lines |
| XRPC Router | Lightweight routing layer - can use Hono or custom (~200 lines) |
| Firehose Event Emitter | WebSocket hibernation is Workers-specific - must build |
| Sequence Manager | Simple counter + event buffer in SQLite (~50 lines) |
| Auth Middleware | Simple bearer token check for MVP (~30 lines) |
| Blob Handler | R2 integration is Workers-specific (~50 lines) |

### Components We Will DEFER

| Component | Reason |
|-----------|--------|
| OAuth Provider | Complex, not needed for single-user MVP |
| Lexicon Validation | Can add later, not required for federation |
| Rate Limiting | Single user, not needed for MVP |
| Account Migration | Complex, post-MVP feature |
| Labelling | AppView concern, not PDS |

---

## Dependencies

All verified to work on Cloudflare Workers with `nodejs_compat`:

```json
{
  "dependencies": {
    "@atproto/common-web": "^0.4.7",
    "@atproto/crypto": "^0.4.5",
    "@atproto/lex-cbor": "^0.0.3",
    "@atproto/lex-data": "^0.0.3",
    "@atproto/lexicon": "^0.6.0",
    "@atproto/repo": "^0.8.12",
    "@atproto/syntax": "^0.4.2",
    "hono": "^4.11.3"
  },
  "devDependencies": {
    "@arethetypeswrong/cli": "^0.18.2",
    "@cloudflare/vite-plugin": "^1.17.0",
    "@cloudflare/vitest-pool-workers": "https://pkg.pr.new/@cloudflare/vitest-pool-workers@11632",
    "@cloudflare/workers-types": "^4.20251225.0",
    "publint": "^0.3.16",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vite": "^6.0.0",
    "vitest": "^4.0.0",
    "wrangler": "^4.54.0"
  }
}
```

**Key Changes from Original Plan:**
- Using official `@atproto/lex-cbor` instead of direct `@ipld/dag-cbor` and `cborg`
- Using `@atproto/lex-data` for CID operations instead of direct `multiformats`
- Added `@atproto/common-web` for TID utilities
- Removed low-level encoding libraries - all handled by @atproto packages
- Using vitest 4 via PR build for Durable Object testing support

### Compatibility Notes

- **`nodejs_compat`** flag required in wrangler.toml
- **Compatibility date**: `2024-09-23` or later
- **Memory limit**: 128MB - use streaming for large CAR files
- **CPU time**: No limit in Durable Objects (use DO for heavy operations)

---

## Implementation Phases

### Phase 1: Storage Layer

**Goal:** Implement the `RepoStorage` interface that `@atproto/repo` needs.

#### Interface to Implement

Based on research of `@atproto/repo`, implement this interface:

```typescript
interface RepoStorage {
  // Read operations
  getBytes(cid: CID): Promise<Uint8Array | null>
  has(cid: CID): Promise<boolean>
  getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }>

  // Write operations
  putBlock(cid: CID, bytes: Uint8Array, rev: string): Promise<void>
  putMany(blocks: BlockMap, rev: string): Promise<void>

  // Root management
  getRoot(): Promise<CID | null>
  updateRoot(cid: CID, rev: string): Promise<void>

  // Atomic commit
  applyCommit(commit: CommitData): Promise<void>
}
```

#### SQLite Schema

```sql
-- Block storage (MST nodes + record blocks)
CREATE TABLE blocks (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  rev TEXT NOT NULL
);

CREATE INDEX idx_blocks_rev ON blocks(rev);

-- Repo state (single row)
CREATE TABLE repo_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  root_cid TEXT NOT NULL,
  rev TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

-- Initialize with empty state
INSERT INTO repo_state (id, root_cid, rev, seq) VALUES (1, '', '', 0);
```

#### Implementation Pattern

```typescript
export class SqliteRepoStorage implements RepoStorage {
  constructor(private sql: SqlStorage) {}

  async getBytes(cid: CID): Promise<Uint8Array | null> {
    const row = this.sql.exec(
      'SELECT bytes FROM blocks WHERE cid = ?',
      cid.toString()
    ).one()
    return row ? new Uint8Array(row.bytes) : null
  }

  async putMany(blocks: BlockMap, rev: string): Promise<void> {
    const stmt = this.sql.prepare(
      'INSERT OR REPLACE INTO blocks (cid, bytes, rev) VALUES (?, ?, ?)'
    )
    for (const [cid, bytes] of blocks.entries()) {
      stmt.bind(cid.toString(), bytes, rev).run()
    }
  }

  async applyCommit(commit: CommitData): Promise<void> {
    // Transaction: add new blocks, remove old, update root
    this.sql.exec('BEGIN TRANSACTION')
    try {
      // Add new blocks
      await this.putMany(commit.newBlocks, commit.rev)

      // Remove old blocks
      for (const cid of commit.removedCids) {
        this.sql.exec('DELETE FROM blocks WHERE cid = ?', cid.toString())
      }

      // Update root
      this.sql.exec(
        'UPDATE repo_state SET root_cid = ?, rev = ? WHERE id = 1',
        commit.cid.toString(), commit.rev
      )

      this.sql.exec('COMMIT')
    } catch (e) {
      this.sql.exec('ROLLBACK')
      throw e
    }
  }
}
```

#### Testing Strategy

```typescript
// test/storage.test.ts
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { Repo } from '@atproto/repo'
import { Secp256k1Keypair } from '@atproto/crypto'

describe('SqliteRepoStorage', () => {
  it('stores and retrieves blocks', async () => {
    const id = env.ACCOUNT.newUniqueId()
    const stub = env.ACCOUNT.get(id)

    await runInDurableObject(stub, async (instance, state) => {
      const storage = new SqliteRepoStorage(state.storage.sql)

      const cid = CID.parse('bafyreib...')
      const bytes = new Uint8Array([1, 2, 3])

      await storage.putBlock(cid, bytes, 'rev1')
      const retrieved = await storage.getBytes(cid)

      expect(retrieved).toEqual(bytes)
    })
  })

  it('works with @atproto/repo Repo class', async () => {
    const id = env.ACCOUNT.newUniqueId()
    const stub = env.ACCOUNT.get(id)

    await runInDurableObject(stub, async (instance, state) => {
      const storage = new SqliteRepoStorage(state.storage.sql)
      const keypair = await Secp256k1Keypair.create()

      // Create a new repo
      const repo = await Repo.create(storage, 'did:web:example.com', keypair)

      expect(repo.cid).toBeDefined()
      expect(await storage.getRoot()).toEqual(repo.cid)
    })
  })

  it('applies commits atomically', async () => {
    // Test that failed commits roll back
  })
})
```

---

### Phase 2: Durable Object Skeleton

**Goal:** Set up the Account DO with SQLite and basic lifecycle.

#### Wrangler Configuration

```toml
# wrangler.toml
name = "atproto-pds"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "ACCOUNT"
class_name = "AccountDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AccountDurableObject"]

[[r2_buckets]]
binding = "BLOBS"
bucket_name = "pds-blobs"

[vars]
# Non-secret config
PDS_HOSTNAME = "pds.example.com"

# Secrets (set via wrangler secret put)
# DID = "did:web:example.com"
# SIGNING_KEY = "..."
# AUTH_TOKEN = "..."
```

#### Durable Object Implementation

```typescript
// src/account-do.ts
import { DurableObject } from 'cloudflare:workers'
import { Repo } from '@atproto/repo'
import { Secp256k1Keypair } from '@atproto/crypto'
import { SqliteRepoStorage } from './storage'

export class AccountDurableObject extends DurableObject {
  private repo: Repo | null = null
  private storage: SqliteRepoStorage | null = null
  private keypair: Secp256k1Keypair | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Initialize schema before processing requests
    ctx.blockConcurrencyWhile(async () => {
      await this.initialize()
    })
  }

  private async initialize() {
    // Run migrations
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        cid TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        rev TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_rev ON blocks(rev);

      CREATE TABLE IF NOT EXISTS repo_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        root_cid TEXT,
        rev TEXT,
        seq INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO repo_state (id, root_cid, rev, seq)
      VALUES (1, NULL, NULL, 0);
    `)

    this.storage = new SqliteRepoStorage(this.ctx.storage.sql)

    // Load keypair from env
    this.keypair = await Secp256k1Keypair.import(this.env.SIGNING_KEY)

    // Load or create repo
    const root = await this.storage.getRoot()
    if (root) {
      this.repo = await Repo.load(this.storage, root)
    } else {
      this.repo = await Repo.create(
        this.storage,
        this.env.DID,
        this.keypair
      )
    }
  }

  // Expose repo operations via RPC
  async getRecord(collection: string, rkey: string) {
    return this.repo!.getRecord(collection, rkey)
  }

  async createRecord(collection: string, rkey: string, record: unknown) {
    const write = {
      action: WriteOpAction.Create,
      collection,
      rkey,
      record
    }

    const commit = await this.repo!.applyWrites([write], this.keypair!)
    await this.storage!.applyCommit(commit)

    // Emit firehose event
    await this.emitCommitEvent(commit)

    return { uri: `at://${this.env.DID}/${collection}/${rkey}`, cid: commit.cid }
  }

  // ... other repo operations
}
```

#### Testing Strategy

```typescript
// test/account-do.test.ts
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { AccountDurableObject } from '../src/account-do'

describe('AccountDurableObject', () => {
  it('initializes with empty repo on first access', async () => {
    const id = env.ACCOUNT.idFromName('test-account')
    const stub = env.ACCOUNT.get(id)

    await runInDurableObject(stub, async (instance: AccountDurableObject) => {
      expect(instance.repo).toBeDefined()
      expect(instance.repo.did).toBe('did:web:test.example.com')
    })
  })

  it('persists repo state across restarts', async () => {
    const id = env.ACCOUNT.idFromName('test-account')

    // First access - create record
    let stub = env.ACCOUNT.get(id)
    const result = await stub.createRecord('app.bsky.feed.post', 'abc123', {
      text: 'Hello world',
      createdAt: new Date().toISOString()
    })

    // Simulate restart by getting new stub
    stub = env.ACCOUNT.get(id)

    // Verify record persisted
    const record = await stub.getRecord('app.bsky.feed.post', 'abc123')
    expect(record.text).toBe('Hello world')
  })

  it('uses fixed ID for single-user routing', async () => {
    // Always route to "account" ID
    const id = env.ACCOUNT.idFromName('account')
    expect(id.toString()).toBeDefined()
  })
})
```

---

### Phase 3: Core XRPC Endpoints

**Goal:** Implement the minimum endpoints for federation.

#### XRPC Router Setup

Using Hono for lightweight routing:

```typescript
// src/xrpc.ts
import { Hono } from 'hono'

export function createXrpcRouter(env: Env) {
  const app = new Hono()

  // Get the single account DO
  const getAccount = () => {
    const id = env.ACCOUNT.idFromName('account')
    return env.ACCOUNT.get(id)
  }

  // Error handler
  app.onError((err, c) => {
    console.error(err)
    return c.json({
      error: err.name || 'InternalServerError',
      message: err.message
    }, err.status || 500)
  })

  // XRPC endpoints
  return app
}
```

#### Tier 1: Sync Endpoints (Required for Federation)

```typescript
// GET /xrpc/com.atproto.sync.getRepo
app.get('/xrpc/com.atproto.sync.getRepo', async (c) => {
  const did = c.req.query('did')
  if (did !== env.DID) {
    return c.json({ error: 'RepoNotFound', message: 'Unknown DID' }, 404)
  }

  const account = getAccount()
  const carBytes = await account.exportRepo()

  return new Response(carBytes, {
    headers: { 'Content-Type': 'application/vnd.ipld.car' }
  })
})

// GET /xrpc/com.atproto.sync.getRepoStatus
app.get('/xrpc/com.atproto.sync.getRepoStatus', async (c) => {
  const did = c.req.query('did')
  if (did !== env.DID) {
    return c.json({ error: 'RepoNotFound' }, 404)
  }

  const account = getAccount()
  const status = await account.getRepoStatus()

  return c.json({
    did: env.DID,
    active: true,
    rev: status.rev,
    status: 'active'
  })
})

// WS /xrpc/com.atproto.sync.subscribeRepos
// Handled separately via WebSocket upgrade
```

#### Tier 2: Repo Endpoints

```typescript
// GET /xrpc/com.atproto.repo.describeRepo
app.get('/xrpc/com.atproto.repo.describeRepo', async (c) => {
  const did = c.req.query('repo')
  if (did !== env.DID) {
    return c.json({ error: 'RepoNotFound' }, 404)
  }

  return c.json({
    handle: env.HANDLE,
    did: env.DID,
    didDoc: await getDidDocument(env),
    collections: ['app.bsky.feed.post', 'app.bsky.actor.profile'],
    handleIsCorrect: true
  })
})

// GET /xrpc/com.atproto.repo.getRecord
app.get('/xrpc/com.atproto.repo.getRecord', async (c) => {
  const repo = c.req.query('repo')
  const collection = c.req.query('collection')
  const rkey = c.req.query('rkey')

  if (repo !== env.DID) {
    return c.json({ error: 'RepoNotFound' }, 404)
  }

  const account = getAccount()
  const record = await account.getRecord(collection, rkey)

  if (!record) {
    return c.json({ error: 'RecordNotFound' }, 404)
  }

  return c.json({
    uri: `at://${env.DID}/${collection}/${rkey}`,
    cid: record.cid.toString(),
    value: record.value
  })
})

// POST /xrpc/com.atproto.repo.createRecord
app.post('/xrpc/com.atproto.repo.createRecord', authMiddleware, async (c) => {
  const body = await c.req.json()
  const { repo, collection, rkey, record } = body

  if (repo !== env.DID) {
    return c.json({ error: 'InvalidRequest', message: 'Wrong repo' }, 400)
  }

  const account = getAccount()
  const result = await account.createRecord(
    collection,
    rkey || TID.nextStr(),
    record
  )

  return c.json(result)
})

// POST /xrpc/com.atproto.repo.deleteRecord
app.post('/xrpc/com.atproto.repo.deleteRecord', authMiddleware, async (c) => {
  const body = await c.req.json()
  const { repo, collection, rkey } = body

  if (repo !== env.DID) {
    return c.json({ error: 'InvalidRequest' }, 400)
  }

  const account = getAccount()
  await account.deleteRecord(collection, rkey)

  return c.json({})
})
```

#### Tier 3: Server Identity

```typescript
// GET /xrpc/com.atproto.server.describeServer
app.get('/xrpc/com.atproto.server.describeServer', (c) => {
  return c.json({
    did: `did:web:${env.PDS_HOSTNAME}`,
    availableUserDomains: [],
    inviteCodeRequired: false,
    phoneVerificationRequired: false,
    links: {}
  })
})

// GET /xrpc/com.atproto.identity.resolveHandle
app.get('/xrpc/com.atproto.identity.resolveHandle', (c) => {
  const handle = c.req.query('handle')

  if (handle !== env.HANDLE) {
    return c.json({ error: 'HandleNotFound' }, 404)
  }

  return c.json({ did: env.DID })
})
```

#### Testing Strategy

```typescript
// test/xrpc.test.ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('XRPC Endpoints', () => {
  describe('com.atproto.sync.getRepo', () => {
    it('returns CAR file for valid DID', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.sync.getRepo?did=did:web:pds.test'
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/vnd.ipld.car')

      const bytes = await response.arrayBuffer()
      expect(bytes.byteLength).toBeGreaterThan(0)
    })

    it('returns 404 for unknown DID', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.sync.getRepo?did=did:web:other.com'
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('RepoNotFound')
    })
  })

  describe('com.atproto.repo.createRecord', () => {
    it('requires authentication', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.repo.createRecord',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: 'did:web:pds.test',
            collection: 'app.bsky.feed.post',
            record: { text: 'Hello', createdAt: new Date().toISOString() }
          })
        }
      )

      expect(response.status).toBe(401)
    })

    it('creates record with valid auth', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.repo.createRecord',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token'
          },
          body: JSON.stringify({
            repo: 'did:web:pds.test',
            collection: 'app.bsky.feed.post',
            record: { text: 'Hello', createdAt: new Date().toISOString() }
          })
        }
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.uri).toMatch(/^at:\/\//)
      expect(body.cid).toBeDefined()
    })
  })

  describe('com.atproto.repo.getRecord', () => {
    it('retrieves created record', async () => {
      // First create a record
      await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.repo.createRecord',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token'
          },
          body: JSON.stringify({
            repo: 'did:web:pds.test',
            collection: 'app.bsky.feed.post',
            rkey: 'test123',
            record: { text: 'Hello', createdAt: new Date().toISOString() }
          })
        }
      )

      // Then retrieve it
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.repo.getRecord?' +
        'repo=did:web:pds.test&collection=app.bsky.feed.post&rkey=test123'
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.value.text).toBe('Hello')
    })
  })
})
```

---

### Phase 4: Firehose (subscribeRepos)

**Goal:** Implement the WebSocket event stream that relays subscribe to.

#### Frame Format

Each WebSocket frame consists of two concatenated DAG-CBOR objects:

```typescript
// Frame structure
interface FirehoseFrame {
  header: { op: 1; t: string } | { op: -1 }  // op=1 message, op=-1 error
  body: CommitEvent | IdentityEvent | ErrorBody
}

interface CommitEvent {
  seq: number           // Sequence number
  rebase: false         // Deprecated
  tooBig: false         // Oversized indicator
  repo: string          // DID
  commit: CID           // Commit CID
  rev: string           // Revision TID
  since: string | null  // Previous revision
  blocks: Uint8Array    // CAR file with diff blocks
  ops: RepoOp[]         // Record operations
  blobs: CID[]          // Referenced blobs
  time: string          // ISO timestamp
}

interface RepoOp {
  action: 'create' | 'update' | 'delete'
  path: string          // collection/rkey
  cid: CID | null       // New CID (null for deletes)
}
```

#### Sequence Manager

```sql
-- Add to schema
CREATE TABLE firehose_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Keep last 10,000 events, prune older
CREATE TRIGGER prune_firehose_events
AFTER INSERT ON firehose_events
BEGIN
  DELETE FROM firehose_events
  WHERE seq < (SELECT MAX(seq) - 10000 FROM firehose_events);
END;
```

```typescript
// src/sequencer.ts
import * as cbor from 'cborg'
import { blocksToCarFile } from '@atproto/repo'

export class Sequencer {
  constructor(private sql: SqlStorage) {}

  async sequenceCommit(commit: CommitData): Promise<number> {
    // Create CAR slice with commit diff
    const carBytes = await blocksToCarFile(commit.cid, commit.newBlocks)

    // Build event payload
    const event = {
      repo: commit.did,
      commit: commit.cid,
      rev: commit.rev,
      since: commit.since,
      blocks: carBytes,
      ops: commit.ops.map(op => ({
        action: op.action,
        path: `${op.collection}/${op.rkey}`,
        cid: op.cid
      })),
      rebase: false,
      tooBig: carBytes.length > 1_000_000,
      blobs: [],
      time: new Date().toISOString()
    }

    // Store in SQLite
    const result = this.sql.exec(
      `INSERT INTO firehose_events (event_type, payload, created_at)
       VALUES ('commit', ?, datetime('now'))
       RETURNING seq`,
      cbor.encode(event)
    ).one()

    return result.seq
  }

  async getEventsSince(cursor: number, limit = 100): Promise<SeqEvent[]> {
    const rows = this.sql.exec(
      `SELECT seq, event_type, payload, created_at
       FROM firehose_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
      cursor, limit
    ).toArray()

    return rows.map(row => ({
      seq: row.seq,
      type: row.event_type,
      event: cbor.decode(row.payload),
      time: row.created_at
    }))
  }

  getLatestSeq(): number {
    const row = this.sql.exec(
      'SELECT MAX(seq) as seq FROM firehose_events'
    ).one()
    return row?.seq ?? 0
  }
}
```

#### WebSocket Hibernation Handler

```typescript
// src/firehose.ts
import * as cbor from 'cborg'

export class FirehoseHandler {
  constructor(
    private ctx: DurableObjectState,
    private sequencer: Sequencer
  ) {}

  async handleUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')

    // Create WebSocket pair
    const { 0: client, 1: server } = new WebSocketPair()

    // Accept with hibernation
    this.ctx.acceptWebSocket(server)

    // Store cursor in attachment
    server.serializeAttachment({
      cursor: cursor ? parseInt(cursor) : null,
      connectedAt: Date.now()
    })

    // Backfill if cursor provided
    if (cursor) {
      await this.backfill(server, parseInt(cursor))
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  private async backfill(ws: WebSocket, cursor: number) {
    const latestSeq = this.sequencer.getLatestSeq()

    // Check if cursor is in future
    if (cursor > latestSeq) {
      const frame = this.encodeError('FutureCursor', 'Cursor in the future')
      ws.send(frame)
      ws.close(1008, 'FutureCursor')
      return
    }

    // Backfill from cursor
    const events = await this.sequencer.getEventsSince(cursor, 1000)

    for (const event of events) {
      const frame = this.encodeCommitFrame(event)
      ws.send(frame)
    }

    // Update cursor in attachment
    if (events.length > 0) {
      const attachment = ws.deserializeAttachment()
      attachment.cursor = events[events.length - 1].seq
      ws.serializeAttachment(attachment)
    }
  }

  // Called when DO has new commit
  async broadcast(event: SeqEvent) {
    const frame = this.encodeCommitFrame(event)

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame)

        // Update cursor
        const attachment = ws.deserializeAttachment()
        attachment.cursor = event.seq
        ws.serializeAttachment(attachment)
      } catch (e) {
        // Client disconnected, will be cleaned up
      }
    }
  }

  private encodeCommitFrame(event: SeqEvent): Uint8Array {
    const header = cbor.encode({ op: 1, t: '#commit' })
    const body = cbor.encode({ seq: event.seq, ...event.event })

    const frame = new Uint8Array(header.length + body.length)
    frame.set(header, 0)
    frame.set(body, header.length)

    return frame
  }

  private encodeError(error: string, message: string): Uint8Array {
    const header = cbor.encode({ op: -1 })
    const body = cbor.encode({ error, message })

    const frame = new Uint8Array(header.length + body.length)
    frame.set(header, 0)
    frame.set(body, header.length)

    return frame
  }

  // Hibernation callbacks
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Firehose is server-push only, ignore client messages
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Cleanup handled automatically
  }

  webSocketError(ws: WebSocket, error: Error) {
    console.error('WebSocket error:', error)
  }
}
```

#### Testing Strategy

```typescript
// test/firehose.test.ts
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import * as cbor from 'cborg'

describe('Firehose', () => {
  it('accepts WebSocket connections', async () => {
    const id = env.ACCOUNT.idFromName('account')
    const stub = env.ACCOUNT.get(id)

    const response = await stub.fetch(
      'https://pds.test/xrpc/com.atproto.sync.subscribeRepos',
      { headers: { Upgrade: 'websocket' } }
    )

    expect(response.status).toBe(101)
    expect(response.webSocket).toBeDefined()
  })

  it('backfills events from cursor', async () => {
    const id = env.ACCOUNT.idFromName('account')
    const stub = env.ACCOUNT.get(id)

    // Create some records first
    for (let i = 0; i < 5; i++) {
      await stub.createRecord('app.bsky.feed.post', `post${i}`, {
        text: `Post ${i}`,
        createdAt: new Date().toISOString()
      })
    }

    // Connect with cursor=0 to get all events
    const response = await stub.fetch(
      'https://pds.test/xrpc/com.atproto.sync.subscribeRepos?cursor=0',
      { headers: { Upgrade: 'websocket' } }
    )

    const ws = response.webSocket!
    ws.accept()

    const messages: Uint8Array[] = []
    ws.addEventListener('message', (event) => {
      messages.push(new Uint8Array(event.data as ArrayBuffer))
    })

    // Wait for backfill
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(messages.length).toBe(5)

    // Verify frame structure
    for (const msg of messages) {
      // First decode header
      const [header, headerLen] = cbor.decodeFirst(msg)
      expect(header.op).toBe(1)
      expect(header.t).toBe('#commit')

      // Then decode body
      const body = cbor.decode(msg.slice(headerLen))
      expect(body.seq).toBeGreaterThan(0)
      expect(body.repo).toBe('did:web:pds.test')
    }

    ws.close()
  })

  it('broadcasts new commits to connected clients', async () => {
    const id = env.ACCOUNT.idFromName('account')
    const stub = env.ACCOUNT.get(id)

    // Connect to firehose
    const response = await stub.fetch(
      'https://pds.test/xrpc/com.atproto.sync.subscribeRepos',
      { headers: { Upgrade: 'websocket' } }
    )

    const ws = response.webSocket!
    ws.accept()

    const messages: any[] = []
    ws.addEventListener('message', (event) => {
      const msg = new Uint8Array(event.data as ArrayBuffer)
      const [header, headerLen] = cbor.decodeFirst(msg)
      const body = cbor.decode(msg.slice(headerLen))
      messages.push({ header, body })
    })

    // Create a record (should broadcast)
    await stub.createRecord('app.bsky.feed.post', 'live-post', {
      text: 'Live post!',
      createdAt: new Date().toISOString()
    })

    // Wait for broadcast
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(messages.length).toBe(1)
    expect(messages[0].body.ops[0].path).toBe('app.bsky.feed.post/live-post')

    ws.close()
  })

  it('rejects future cursor', async () => {
    const id = env.ACCOUNT.idFromName('account')
    const stub = env.ACCOUNT.get(id)

    const response = await stub.fetch(
      'https://pds.test/xrpc/com.atproto.sync.subscribeRepos?cursor=999999',
      { headers: { Upgrade: 'websocket' } }
    )

    const ws = response.webSocket!
    ws.accept()

    let errorReceived = false
    ws.addEventListener('message', (event) => {
      const msg = new Uint8Array(event.data as ArrayBuffer)
      const [header] = cbor.decodeFirst(msg)
      if (header.op === -1) {
        errorReceived = true
      }
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(errorReceived).toBe(true)
  })
})
```

---

### Phase 5: Blob Storage

**Goal:** Support blob upload and retrieval for images/media.

#### R2 Blob Storage

```typescript
// src/blobs.ts
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'

export class BlobStore {
  constructor(private r2: R2Bucket, private did: string) {}

  async putBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
    // Compute CID
    const hash = await sha256.digest(bytes)
    const cid = CID.create(1, 0x55, hash) // raw codec

    // Store in R2 with DID prefix
    const key = `${this.did}/${cid.toString()}`
    await this.r2.put(key, bytes, {
      httpMetadata: { contentType: mimeType }
    })

    return {
      $type: 'blob',
      ref: { $link: cid.toString() },
      mimeType,
      size: bytes.length
    }
  }

  async getBlob(cid: CID): Promise<R2ObjectBody | null> {
    const key = `${this.did}/${cid.toString()}`
    return this.r2.get(key)
  }

  async hasBlob(cid: CID): Promise<boolean> {
    const key = `${this.did}/${cid.toString()}`
    const head = await this.r2.head(key)
    return head !== null
  }
}
```

#### XRPC Endpoints

```typescript
// POST /xrpc/com.atproto.repo.uploadBlob
app.post('/xrpc/com.atproto.repo.uploadBlob', authMiddleware, async (c) => {
  const contentType = c.req.header('Content-Type') || 'application/octet-stream'
  const bytes = new Uint8Array(await c.req.arrayBuffer())

  // Size limit check
  if (bytes.length > 5_000_000) { // 5MB
    return c.json({ error: 'BlobTooLarge' }, 400)
  }

  const account = getAccount()
  const blobRef = await account.uploadBlob(bytes, contentType)

  return c.json({ blob: blobRef })
})

// GET /xrpc/com.atproto.sync.getBlob
app.get('/xrpc/com.atproto.sync.getBlob', async (c) => {
  const did = c.req.query('did')
  const cidStr = c.req.query('cid')

  if (did !== env.DID) {
    return c.json({ error: 'RepoNotFound' }, 404)
  }

  const cid = CID.parse(cidStr)
  const blob = await env.BLOBS.get(`${did}/${cid.toString()}`)

  if (!blob) {
    return c.json({ error: 'BlobNotFound' }, 404)
  }

  return new Response(blob.body, {
    headers: {
      'Content-Type': blob.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': blob.size.toString()
    }
  })
})
```

#### Testing Strategy

```typescript
// test/blobs.test.ts
import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'

describe('Blob Storage', () => {
  it('uploads and retrieves blobs', async () => {
    // Upload
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header
    const uploadResponse = await SELF.fetch(
      'https://pds.test/xrpc/com.atproto.repo.uploadBlob',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'image/png'
        },
        body: imageBytes
      }
    )

    expect(uploadResponse.status).toBe(200)
    const { blob } = await uploadResponse.json()
    expect(blob.ref.$link).toBeDefined()
    expect(blob.mimeType).toBe('image/png')

    // Retrieve
    const getResponse = await SELF.fetch(
      `https://pds.test/xrpc/com.atproto.sync.getBlob?did=did:web:pds.test&cid=${blob.ref.$link}`
    )

    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get('Content-Type')).toBe('image/png')
  })

  it('rejects oversized blobs', async () => {
    const largeBlob = new Uint8Array(6_000_000) // 6MB

    const response = await SELF.fetch(
      'https://pds.test/xrpc/com.atproto.repo.uploadBlob',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/octet-stream'
        },
        body: largeBlob
      }
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('BlobTooLarge')
  })
})
```

---

### Phase 6: Identity & DID Document

**Goal:** Serve the DID document so the network can discover this PDS.

#### DID Document

```typescript
// src/identity.ts
export function generateDidDocument(env: Env) {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1'
    ],
    id: env.DID,
    alsoKnownAs: [`at://${env.HANDLE}`],
    verificationMethod: [
      {
        id: `${env.DID}#atproto`,
        type: 'Multikey',
        controller: env.DID,
        publicKeyMultibase: env.SIGNING_KEY_PUBLIC
      }
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: `https://${env.PDS_HOSTNAME}`
      }
    ]
  }
}
```

#### Well-Known Endpoints

```typescript
// Serve directly from Worker (no DO needed)

// GET /.well-known/did.json (for did:web)
app.get('/.well-known/did.json', (c) => {
  return c.json(generateDidDocument(c.env))
})

// GET /.well-known/atproto-did (handle verification)
app.get('/.well-known/atproto-did', (c) => {
  return c.text(c.env.DID)
})
```

#### Testing Strategy

```typescript
// test/identity.test.ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('Identity', () => {
  describe('DID Document', () => {
    it('serves did:web document', async () => {
      const response = await SELF.fetch(
        'https://pds.test/.well-known/did.json'
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/json')

      const doc = await response.json()
      expect(doc.id).toBe('did:web:pds.test')
      expect(doc.service[0].type).toBe('AtprotoPersonalDataServer')
    })
  })

  describe('Handle Verification', () => {
    it('serves atproto-did for handle verification', async () => {
      const response = await SELF.fetch(
        'https://pds.test/.well-known/atproto-did'
      )

      expect(response.status).toBe(200)
      const did = await response.text()
      expect(did).toBe('did:web:pds.test')
    })
  })

  describe('resolveHandle', () => {
    it('resolves configured handle', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=alice.test'
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.did).toBe('did:web:pds.test')
    })

    it('returns 404 for unknown handle', async () => {
      const response = await SELF.fetch(
        'https://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=unknown.test'
      )

      expect(response.status).toBe(404)
    })
  })
})
```

---

### Phase 7: Authentication

**Goal:** Secure write endpoints.

#### Bearer Token Auth (MVP)

```typescript
// src/auth.ts
export function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'AuthRequired' }, 401)
  }

  const token = authHeader.slice(7)

  if (token !== c.env.AUTH_TOKEN) {
    return c.json({ error: 'InvalidToken' }, 401)
  }

  return next()
}
```

#### Future: JWT Verification

```typescript
// For future OAuth/JWT support
import { verifyJwt } from '@atproto/crypto'

export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'AuthRequired' }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const payload = await verifyJwt(token, {
      audience: `https://${c.env.PDS_HOSTNAME}`,
      issuer: c.env.DID
    })

    c.set('auth', { did: payload.iss, scope: payload.scope })
    return next()
  } catch (e) {
    return c.json({ error: 'InvalidToken', message: e.message }, 401)
  }
}
```

#### Testing Strategy

```typescript
// test/auth.test.ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('Authentication', () => {
  const writeEndpoints = [
    { method: 'POST', path: '/xrpc/com.atproto.repo.createRecord' },
    { method: 'POST', path: '/xrpc/com.atproto.repo.putRecord' },
    { method: 'POST', path: '/xrpc/com.atproto.repo.deleteRecord' },
    { method: 'POST', path: '/xrpc/com.atproto.repo.uploadBlob' }
  ]

  for (const { method, path } of writeEndpoints) {
    it(`requires auth for ${path}`, async () => {
      const response = await SELF.fetch(`https://pds.test${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })

      expect(response.status).toBe(401)
    })
  }

  const readEndpoints = [
    '/xrpc/com.atproto.repo.getRecord?repo=did:web:pds.test&collection=app.bsky.feed.post&rkey=test',
    '/xrpc/com.atproto.repo.describeRepo?repo=did:web:pds.test',
    '/xrpc/com.atproto.sync.getRepo?did=did:web:pds.test'
  ]

  for (const path of readEndpoints) {
    it(`allows unauthenticated access to ${path.split('?')[0]}`, async () => {
      const response = await SELF.fetch(`https://pds.test${path}`)

      // Should not be 401 (might be 404 if no data)
      expect(response.status).not.toBe(401)
    })
  }
})
```

---

## Testing Configuration

### Vitest Setup

```typescript
// vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            DID: 'did:web:pds.test',
            HANDLE: 'alice.test',
            PDS_HOSTNAME: 'pds.test',
            AUTH_TOKEN: 'test-token',
            SIGNING_KEY: 'test-signing-key'
          }
        }
      }
    }
  }
})
```

### Test Environment Types

```typescript
// test/env.d.ts
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    ACCOUNT: DurableObjectNamespace
    BLOBS: R2Bucket
    DID: string
    HANDLE: string
    PDS_HOSTNAME: string
    AUTH_TOKEN: string
    SIGNING_KEY: string
  }
}
```

### Integration Test Suite

```typescript
// test/integration/federation.test.ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('Federation Integration', () => {
  it('complete flow: create post, sync repo, verify on firehose', async () => {
    // 1. Create a post
    const createResponse = await SELF.fetch(
      'https://pds.test/xrpc/com.atproto.repo.createRecord',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token'
        },
        body: JSON.stringify({
          repo: 'did:web:pds.test',
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: 'Hello from edge PDS!',
            createdAt: new Date().toISOString()
          }
        })
      }
    )

    expect(createResponse.status).toBe(200)
    const { uri, cid } = await createResponse.json()

    // 2. Export repo as CAR
    const repoResponse = await SELF.fetch(
      'https://pds.test/xrpc/com.atproto.sync.getRepo?did=did:web:pds.test'
    )

    expect(repoResponse.status).toBe(200)
    const carBytes = await repoResponse.arrayBuffer()
    expect(carBytes.byteLength).toBeGreaterThan(0)

    // 3. Verify record exists
    const getResponse = await SELF.fetch(
      `https://pds.test/xrpc/com.atproto.repo.getRecord?repo=did:web:pds.test&collection=app.bsky.feed.post&rkey=${uri.split('/').pop()}`
    )

    expect(getResponse.status).toBe(200)
    const record = await getResponse.json()
    expect(record.value.text).toBe('Hello from edge PDS!')
  })
})
```

---

## Configuration

| Config | Type | Purpose |
|--------|------|---------|
| `DID` | Secret | The account's DID (did:web:... or did:plc:...) |
| `SIGNING_KEY` | Secret | Private key for signing commits (hex or multibase) |
| `SIGNING_KEY_PUBLIC` | Secret | Public key for DID document |
| `HANDLE` | Variable | The account's handle |
| `AUTH_TOKEN` | Secret | Bearer token for write auth (MVP) |
| `PDS_HOSTNAME` | Variable | Public hostname of the PDS |

Set secrets via:
```bash
wrangler secret put DID
wrangler secret put SIGNING_KEY
wrangler secret put SIGNING_KEY_PUBLIC
wrangler secret put AUTH_TOKEN
```

---

## Suggested Order of Work

1. **Storage adapter** – get `@atproto/repo` working with DO SQLite
2. **DO skeleton** – basic structure, initialization, repo instance
3. **describeRepo / getRecord** – prove reads work
4. **createRecord** – prove writes work
5. **getRepo (CAR export)** – sync endpoint
6. **subscribeRepos** – firehose (this is the complex one)
7. **Blob upload/get** – R2 integration
8. **DID document** – identity endpoints
9. **Auth** – lock down write endpoints
10. **Polish** – error handling, logging, tests

---

## Out of Scope (for MVP)

- Account creation / multi-user
- OAuth / third-party app auth
- Account migration
- Labelling
- Email verification
- Rate limiting
- Admin endpoints

These can all be added later.

---

## Reference Material

- AT Protocol specs: https://atproto.com/specs
- `@atproto/repo` source: https://github.com/bluesky-social/atproto/tree/main/packages/repo
- `@atproto/pds` source (reference implementation): https://github.com/bluesky-social/atproto/tree/main/packages/pds
- XRPC spec: https://atproto.com/specs/xrpc
- Sync spec (firehose): https://atproto.com/specs/sync
- Repo spec: https://atproto.com/specs/repository
- Cloudflare Workers testing: https://developers.cloudflare.com/workers/testing/vitest-integration/
