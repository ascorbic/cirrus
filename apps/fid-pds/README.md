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

### Prerequisites

The `@getcirrus/pds` package must be built before deploying since `fid-pds` imports from it as a workspace dependency:

```bash
# From repository root
pnpm build
```

### First-time setup

1. **Set secrets** (these are not in `wrangler.jsonc`):

   ```bash
   # Generate and set JWT signing secret
   openssl rand -base64 32
   wrangler secret put JWT_SECRET
   # paste the generated value when prompted
   ```

2. **Configure DNS** in Cloudflare dashboard for `fid.is`:

   | Type | Name | Target | Proxy |
   |------|------|--------|-------|
   | CNAME | `@` | `fid-pds.<account>.workers.dev` | Proxied |
   | CNAME | `*` | `fid-pds.<account>.workers.dev` | Proxied |
   | CNAME | `my` | `fid-pds.<account>.workers.dev` | Proxied |

   The wildcard `*` record is required for per-FID subdomains (e.g., `12345.fid.is`).
   The `my` record is for the management subdomain (`my.fid.is`).

3. **Routes** are configured in `wrangler.jsonc`:
   - `fid.is` — apex domain
   - `*.fid.is` — wildcard covers per-FID subdomains (`12345.fid.is`) and the management subdomain (`my.fid.is`)

### Deploy

```bash
# From apps/fid-pds/
bun run deploy
```

### Verify

```bash
curl https://fid.is/xrpc/_health
# Should return: {"status":"ok",...}
```

### Environment variables

Non-sensitive values are configured in `wrangler.jsonc` under `vars`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `WEBFID_DOMAIN` | `fid.is` | Base domain for FID subdomains |
| `QUICKAUTH_DOMAIN` | `my.fid.is` | Management subdomain for Quick Auth |
| `INITIAL_ACTIVE` | `true` | Accounts are active on creation |

Secrets (set via `wrangler secret put`):

| Secret | Purpose |
|--------|---------|
| `JWT_SECRET` | Signing key for session JWTs |

### Bindings

Configured in `wrangler.jsonc`:

- **ACCOUNT** - Durable Object (`AccountDurableObject`) — per-user state and SQLite storage
- **BLOBS** - R2 bucket (`fid-pds-blobs`) — blob storage
- **USER_REGISTRY** - D1 database (`fid-pds-registry`) — FID-to-DID lookup
