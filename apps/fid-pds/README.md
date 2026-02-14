# fid-pds

Deployment wrapper for the fid.is multi-tenant PDS.

## Development

1. Copy `.dev.vars.example` to `.dev.vars` and configure:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. Start the dev server:
   ```bash
   pnpm dev
   ```

3. The PDS will be available at `http://localhost:8787`

## Configuration

Environment variables in `.dev.vars`:

- `WEBFID_DOMAIN` - Domain for WebFID DIDs (e.g., `localhost:8787` or tunnel domain)
- `QUICKAUTH_DOMAIN` - Farcaster Quick Auth audience domain
- `JWT_SECRET` - JWT signing secret (at least 32 characters)
- `INITIAL_ACTIVE` - Initial activation state for new accounts

## Deployment

Deploy to Cloudflare Workers:

```bash
pnpm deploy
```

Production environment variables should be configured in Cloudflare dashboard or via `wrangler secret put`.
