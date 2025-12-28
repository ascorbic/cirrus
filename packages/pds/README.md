# @ascorbic/pds

A single-user [AT Protocol](https://atproto.com) Personal Data Server (PDS) that runs on Cloudflare Workers. Host your own Bluesky identity with minimal infrastructure.

> **⚠️ Experimental Software**
>
> This is an early-stage project under active development. **Do not migrate your main Bluesky account to this PDS yet.** Use a test account or create a new identity for experimentation. Data loss, breaking changes, and missing features are expected.

## What is this?

A PDS is where your Bluesky data lives – your posts, follows, profile, and media. This package lets you run your own PDS on Cloudflare Workers, giving you control over your data and identity.

## Quick Start

The fastest way to get started:

```bash
npm create pds
```

This scaffolds a new project, installs dependencies, and runs the setup wizard to configure your PDS.

Then start the dev server:

```bash
cd pds-worker
npm run dev
```

## Manual Installation

If you prefer to set things up yourself:

### 1. Install the package

```bash
npm install @ascorbic/pds
```

### 2. Create a worker entry point

```typescript
// src/index.ts
export { default, AccountDurableObject } from "@ascorbic/pds";
```

### 3. Configure wrangler.jsonc

```jsonc
{
	"name": "my-pds",
	"main": "src/index.ts",
	"compatibility_date": "2024-12-01",
	"compatibility_flags": ["nodejs_compat"],
	"durable_objects": {
		"bindings": [{ "name": "ACCOUNT", "class_name": "AccountDurableObject" }],
	},
	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["AccountDurableObject"] },
	],
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "pds-blobs" }],
}
```

### 4. Run the setup wizard

```bash
pnpm pds init
```

This prompts for your hostname, handle, and password, then generates signing keys and writes configuration.

## CLI

The package includes a CLI for setup and configuration:

```bash
pds init                 # Interactive setup (writes to .dev.vars)
pds init --production    # Deploy secrets to Cloudflare
pds secret key           # Generate new signing keypair
pds secret jwt           # Generate new JWT secret
pds secret password      # Set account password
```

## Deploying to Production

1. [Enable R2 in your Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview) (the bucket will be created automatically on first deploy).

2. Run the production setup to deploy secrets:

```bash
npx pds init --production
```

3. Deploy your worker:

```bash
wrangler deploy
```

4. Configure DNS to point your domain to the worker.

## Identity: DIDs and Handles

AT Protocol uses two types of identifiers:

- **DID** (Decentralized Identifier): Your permanent, cryptographic identity (e.g., `did:web:pds.example.com`). This never changes and is tied to your signing key.
- **Handle**: Your human-readable username (e.g., `alice.example.com`). This can be any domain you control.

The DID document (served at `/.well-known/did.json`) contains your public key and tells the network where your PDS is. The `alsoKnownAs` field links your DID to your handle.

### Handle Verification

Bluesky verifies that you control your handle domain. There are two methods:

#### Option A: Handle matches PDS hostname

If your handle is the same as your PDS hostname (e.g., both are `pds.example.com`):

- The PDS automatically serves `/.well-known/atproto-did` returning your DID
- No additional DNS setup needed
- This is the simplest option

#### Option B: Handle on a different domain

If you want a handle on a different domain (e.g., handle `alice.example.com` while PDS is at `pds.example.com`):

1. Add a DNS TXT record to your handle domain:

```
_atproto.alice.example.com  TXT  "did=did:web:pds.example.com"
```

2. Verify it's working:

```bash
dig TXT _atproto.alice.example.com
```

This lets you use any domain you own as your Bluesky handle, even your personal website.

## Configuration

The PDS uses environment variables for configuration. Public values go in `wrangler.jsonc`, secrets are stored via Wrangler or in `.dev.vars` for local development.

### Public Variables (wrangler.jsonc)

| Variable             | Description                              |
| -------------------- | ---------------------------------------- |
| `PDS_HOSTNAME`       | Public hostname (e.g., pds.example.com)  |
| `DID`                | Account DID (did:web:... or did:plc:...) |
| `HANDLE`             | Account handle                           |
| `SIGNING_KEY_PUBLIC` | Public key for DID document (multibase)  |

### Secrets

| Variable        | Description                           |
| --------------- | ------------------------------------- |
| `AUTH_TOKEN`    | Bearer token for API write operations |
| `SIGNING_KEY`   | Private signing key (secp256k1 JWK)   |
| `JWT_SECRET`    | Secret for signing session JWTs       |
| `PASSWORD_HASH` | Bcrypt hash of password for app login |

## API Endpoints

### Public

| Endpoint                                    | Description                  |
| ------------------------------------------- | ---------------------------- |
| `GET /.well-known/did.json`                 | DID document                 |
| `GET /.well-known/atproto-did`              | Handle verification          |
| `GET /xrpc/com.atproto.sync.getRepo`        | Export repository as CAR     |
| `GET /xrpc/com.atproto.sync.subscribeRepos` | WebSocket firehose           |
| `GET /xrpc/com.atproto.repo.describeRepo`   | Repository metadata          |
| `GET /xrpc/com.atproto.repo.getRecord`      | Get a single record          |
| `GET /xrpc/com.atproto.repo.listRecords`    | List records in a collection |

### Authenticated

| Endpoint                                       | Description                |
| ---------------------------------------------- | -------------------------- |
| `POST /xrpc/com.atproto.server.createSession`  | Login (returns JWT)        |
| `POST /xrpc/com.atproto.server.refreshSession` | Refresh JWT                |
| `POST /xrpc/com.atproto.repo.createRecord`     | Create a record            |
| `POST /xrpc/com.atproto.repo.deleteRecord`     | Delete a record            |
| `POST /xrpc/com.atproto.repo.putRecord`        | Create or update a record  |
| `POST /xrpc/com.atproto.repo.uploadBlob`       | Upload a blob              |
| `POST /xrpc/com.atproto.repo.importRepo`       | Import repository from CAR |

## Architecture

The PDS runs as a Cloudflare Worker with a Durable Object for state:

- **Worker**: Handles routing, authentication, and DID document serving
- **AccountDurableObject**: Stores repository data in SQLite, manages the Merkle tree
- **R2**: Stores blobs (images, videos)

## Limitations

- **Single-user only**: One account per deployment
- **No account creation**: The owner is configured at deploy time
- **did:web only**: Uses domain-based DIDs (did:plc support planned)

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
