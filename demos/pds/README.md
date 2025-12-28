# Demo PDS Deployment

This is an example deployment of `@ascorbic/pds-worker` - a single-user AT Protocol Personal Data Server on Cloudflare Workers.

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Use the PDS CLI to generate keys and configure your environment:

```bash
npx @ascorbic/pds-worker init --local
```

This will prompt for your hostname, handle, and password, then write all secrets to `.dev.vars`.

Alternatively, copy `.env.example` to `.dev.vars` and fill in values manually.

### 3. Run locally

```bash
pnpm run dev
```

This starts a local development server using Miniflare with your `.dev.vars` configuration.

### 4. Deploy to production

Use the PDS CLI to set secrets via wrangler:

```bash
npx @ascorbic/pds-worker init --production
```

Or set secrets individually:

```bash
npx @ascorbic/pds-worker secret key      # Generate signing keypair
npx @ascorbic/pds-worker secret jwt      # Generate JWT secret
npx @ascorbic/pds-worker secret password # Set login password
```

Then deploy:

```bash
pnpm run deploy
```

## Configuration

All configuration is via environment variables:

**Required (non-secret):**
- `PDS_HOSTNAME` - Public hostname (set in wrangler.jsonc)

**Required (secrets):**
- `DID` - Your account's DID
- `HANDLE` - Your account's handle
- `AUTH_TOKEN` - Bearer token for write operations
- `SIGNING_KEY` - Private key for signing commits (secp256k1 JWK)
- `SIGNING_KEY_PUBLIC` - Public key for DID document (multibase)
- `JWT_SECRET` - Secret for signing session JWTs

**Optional (secrets):**
- `PASSWORD_HASH` - Bcrypt hash of account password (enables app login)

## Architecture

This deployment simply re-exports the `@ascorbic/pds-worker` package:

```typescript
// src/index.ts
export { default, AccountDurableObject } from '@ascorbic/pds-worker';
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

- [PDS Package](../../packages/pds)
- [AT Protocol Docs](https://atproto.com)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
