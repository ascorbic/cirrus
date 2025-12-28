# Personal PDS on Cloudflare Workers

This is an example deployment of `@ascorbic/pds-worker` - a single-user AT Protocol Personal Data Server on Cloudflare Workers.

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Use the PDS CLI to generate keys and configure your environment:

```bash
pnpm pds init --local
```

This will prompt for your hostname, handle, and password, then write configuration to `.dev.vars`.

### 3. Run locally

```bash
pnpm dev
```

This starts a local development server using Miniflare with your `.dev.vars` configuration.

### 4. Deploy to production

Use the PDS CLI to configure for production:

```bash
pnpm pds init
```

This sets vars in `wrangler.jsonc` and secrets via `wrangler secret put`.

Or configure secrets individually:

```bash
pnpm pds secret key      # Generate signing keypair
pnpm pds secret jwt      # Generate JWT secret
pnpm pds secret password # Set login password
```

Then deploy:

```bash
pnpm run deploy
```

## Configuration

Configuration is via environment variables: vars in the `wrangler.jsonc` and secrets. Use `pnpm pds init` to configure interactively.

**Vars (in wrangler.jsonc):**

- `PDS_HOSTNAME` - Public hostname of the PDS
- `DID` - Account DID (e.g., did:web:pds.example.com)
- `HANDLE` - Account handle (e.g., alice.example.com)
- `SIGNING_KEY_PUBLIC` - Public key for DID document (multibase)

**Secrets (via wrangler):**

- `AUTH_TOKEN` - Bearer token for API write operations
- `SIGNING_KEY` - Private signing key (secp256k1 JWK)
- `JWT_SECRET` - Secret for signing session JWTs
- `PASSWORD_HASH` - Bcrypt hash of account password (for Bluesky app login)

## Architecture

This deployment simply re-exports the `@ascorbic/pds-worker` package:

```typescript
// src/index.ts
export { default, AccountDurableObject } from "@ascorbic/pds-worker";
```

No additional code needed!

## Endpoints

Once deployed, your PDS will serve:

- `GET /.well-known/did.json` - DID document
- `GET /health` - Health check
- `GET /xrpc/com.atproto.sync.getRepo` - Export repository as CAR
- `GET /xrpc/com.atproto.sync.subscribeRepos` - WebSocket firehose
- `POST /xrpc/com.atproto.repo.createRecord` - Create a record (authenticated)
- `POST /xrpc/com.atproto.repo.uploadBlob` - Upload a blob (authenticated)
- And more...

## Resources

- [AT Protocol Docs](https://atproto.com)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
