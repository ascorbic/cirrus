# @ascorbic/pds-worker

A single-user AT Protocol Personal Data Server (PDS) for Cloudflare Workers.

## Features

- Full AT Protocol federation support
- WebSocket firehose for real-time sync
- Blob storage via R2
- Session authentication for Bluesky app login
- Lexicon validation for record schemas
- Account migration (import/export)

## Quick Start

### 1. Create a new project

```bash
mkdir my-pds && cd my-pds
npm init -y
npm install @ascorbic/pds-worker
```

### 2. Create the worker entry point

```typescript
// src/index.ts
export { default, AccountDurableObject } from "@ascorbic/pds-worker";
```

### 3. Configure wrangler.jsonc

```jsonc
{
	"name": "my-pds",
	"main": "src/index.ts",
	"compatibility_date": "2024-09-23",
	"compatibility_flags": ["nodejs_compat"],
	"vars": {
		"PDS_HOSTNAME": "pds.example.com"
	},
	"durable_objects": {
		"bindings": [{ "name": "ACCOUNT", "class_name": "AccountDurableObject" }]
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["AccountDurableObject"] }],
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "pds-blobs" }]
}
```

### 4. Run the setup wizard

```bash
# For local development
npx @ascorbic/pds-worker init --local

# For production (sets wrangler secrets)
npx @ascorbic/pds-worker init
```

### 5. Deploy

```bash
wrangler r2 bucket create pds-blobs
wrangler deploy
```

## CLI Commands

The package includes a CLI for configuration:

```bash
pds init                 # Full interactive setup wizard
pds init --local         # Write to .dev.vars for local dev
pds secret jwt           # Generate JWT signing secret
pds secret password      # Set account password
pds secret key           # Generate signing keypair
```

## Configuration

| Variable             | Type   | Description                                |
| -------------------- | ------ | ------------------------------------------ |
| `PDS_HOSTNAME`       | Var    | Public hostname of the PDS                 |
| `DID`                | Var    | Account DID (did:web:... or did:plc:...)   |
| `HANDLE`             | Var    | Account handle                             |
| `SIGNING_KEY_PUBLIC` | Var    | Public key for DID document (multibase)    |
| `AUTH_TOKEN`         | Secret | Bearer token for API write operations      |
| `SIGNING_KEY`        | Secret | Private signing key (secp256k1 JWK)        |
| `JWT_SECRET`         | Secret | Secret for signing session JWTs            |
| `PASSWORD_HASH`      | Secret | Bcrypt hash of password for app login      |

## Endpoints

### Public

- `GET /.well-known/did.json` - DID document
- `GET /.well-known/atproto-did` - Handle verification
- `GET /health` - Health check
- `GET /xrpc/com.atproto.sync.getRepo` - Export repository as CAR
- `GET /xrpc/com.atproto.sync.subscribeRepos` - WebSocket firehose
- `GET /xrpc/com.atproto.repo.getRecord` - Get a record
- `GET /xrpc/com.atproto.repo.listRecords` - List records

### Authenticated

- `POST /xrpc/com.atproto.server.createSession` - Login
- `POST /xrpc/com.atproto.repo.createRecord` - Create a record
- `POST /xrpc/com.atproto.repo.deleteRecord` - Delete a record
- `POST /xrpc/com.atproto.repo.uploadBlob` - Upload a blob
- `POST /xrpc/com.atproto.repo.importRepo` - Import repository from CAR

## Resources

- [AT Protocol Docs](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
