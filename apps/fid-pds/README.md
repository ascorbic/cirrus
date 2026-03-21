# fid-pds

Deployment wrapper for the [fid.is](https://fid.is) multi-tenant PDS — a service that gives every Farcaster user an AT Protocol identity and Personal Data Server, derived from their Farcaster ID (FID).

## How It Works

For FID `NNN`:

| Concept | Value | Example |
|---------|-------|---------|
| **DID** | `did:web:NNN.fid.is` | `did:web:1898.fid.is` |
| **Handle** | `NNN.fid.is` | `1898.fid.is` |
| **PDS hostname** | `pds-NNN.fid.is` | `pds-1898.fid.is` |
| **DID document** | `https://NNN.fid.is/.well-known/did.json` | served on the DID hostname |

The DID hostname (`NNN.fid.is`) and PDS hostname (`pds-NNN.fid.is`) are intentionally different. The DID document at `NNN.fid.is` advertises `pds-NNN.fid.is` as the PDS service endpoint. Both hostnames route to the same Durable Object via Cloudflare's wildcard DNS.

### Why separate hostnames?

Bluesky's relay caches state per PDS hostname. If an account is deleted and re-created, the relay won't re-crawl the same hostname. Using a distinct `pds-NNN` hostname for the PDS endpoint gives the relay a fresh identity to connect to, while the DID (`did:web:NNN.fid.is`) remains stable.

### Custom PDS URL

Users can override the PDS service endpoint in their DID document to point to an external PDS (e.g., for self-hosting or migration). The DID identity (`did:web:NNN.fid.is`) stays on fid.is — only the advertised PDS endpoint changes. This is managed via the `is.fid.settings.setPdsUrl` endpoint.

### Account vs Repo Lifecycle

These are independent concepts:

- **FID-PDS account** — exists as long as the AT Protocol identity (DID, keys) is stored. Allows login, DID document management, and settings changes.
- **Repo status** (`active` / `deactivated` / `deleted`) — controls whether AT Protocol repo operations (reads, writes, firehose) are available.

A user with a deleted repo can still log in and manage their DID document (e.g., point it to an external PDS). Account deletion only removes repo data — the identity persists for DID management.

### Authentication

Two auth mechanisms are supported:

- **Bearer JWT** — issued by `is.fid.auth.loginFarcasterMini` / `is.fid.account.createFarcasterMini` endpoints. Used by the miniapp.
- **OAuth 2.1 DPoP** — standard AT Protocol OAuth flow. Used by Bluesky clients and third-party apps. Tokens are issued via `/oauth/token` and verified by the DPoP middleware.

Both auth types work for all authenticated endpoints including `getSession`.

## Architecture

```
apps/fid-pds/          ← This package (deployment wrapper)
  src/index.ts         ← Re-exports from @fidis/pds
  wrangler.jsonc       ← Cloudflare Workers config
  .dev.vars            ← Local development secrets

packages/pds/          ← Core library (@fidis/pds)
  src/index.ts         ← Worker entry point, routing, DID doc serving
  src/account-do.ts    ← AccountDurableObject (per-user state)
  src/oauth.ts         ← OAuth 2.1 provider
  src/farcaster-auth.ts ← FID/DID/handle derivation utilities

apps/miniapp/          ← Account management UI (React + Vite)
```

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

For testing with Farcaster auth, you'll need a Cloudflare tunnel:
```bash
cloudflared tunnel --url http://localhost:8787
```
Then update `WEBFID_DOMAIN` in `.dev.vars` to the tunnel domain.

## Environment Variables

### Non-sensitive (in `wrangler.jsonc` → `vars`)

| Variable | Value | Purpose |
|----------|-------|---------|
| `WEBFID_DOMAIN` | `fid.is` | Base domain for FID subdomains. Used to derive DIDs (`did:web:NNN.{domain}`), handles (`NNN.{domain}`), and PDS hostnames (`pds-NNN.{domain}`). |
| `QUICKAUTH_DOMAIN` | `my.fid.is` | Audience domain for Farcaster Quick Auth JWT verification. This is the domain the miniapp runs on. |
| `INITIAL_ACTIVE` | `true` | Whether new accounts start with an active repo. Set to `false` to require explicit activation after creation. |

### Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `JWT_SECRET` | HMAC secret for signing session JWTs (access + refresh tokens). Must be at least 32 characters. |

### Local development overrides (`.dev.vars`)

For local development, these override the `wrangler.jsonc` values:

```bash
# Domain — use tunnel domain for Farcaster auth testing
WEBFID_DOMAIN=your-tunnel.trycloudflare.com

# Quick Auth audience — miniapp tunnel domain
QUICKAUTH_DOMAIN=your-miniapp-tunnel.trycloudflare.com

# JWT secret — any 32+ char string for local dev
JWT_SECRET=your-jwt-secret-at-least-32-chars-long

# Start accounts as active
INITIAL_ACTIVE=true
```

### Optional variables

| Variable | Purpose |
|----------|---------|
| `DATA_LOCATION` | Durable Object location hint. `"eu"` for EU jurisdiction (hard guarantee), `"wnam"`/`"enam"` etc. for location hints, `"auto"` or omit for default. |
| `EMAIL` | Fallback email for `getSession` responses if no per-account email is stored. |

## Cloudflare Bindings

Configured in `wrangler.jsonc`:

| Binding | Type | Resource | Purpose |
|---------|------|----------|---------|
| `ACCOUNT` | Durable Object | `AccountDurableObject` | Per-user state — identity, repo, SQLite storage |
| `BLOBS` | R2 Bucket | `fid-pds-blobs` | Blob storage for uploaded media |
| `USER_REGISTRY` | D1 Database | `fid-pds-registry` | FID-to-DID registry for user enumeration |

## Deployment

### First-time setup

1. **Set secrets:**
   ```bash
   openssl rand -base64 32
   wrangler secret put JWT_SECRET
   # paste the generated value when prompted
   ```

2. **Configure DNS** in Cloudflare dashboard for `fid.is`:

   | Type | Name | Target | Proxy |
   |------|------|--------|-------|
   | CNAME | `@` | `fid-pds.<account>.workers.dev` | Proxied |
   | CNAME | `*` | `fid-pds.<account>.workers.dev` | Proxied |

   The wildcard `*` record covers all subdomains: `NNN.fid.is` (DID/handle), `pds-NNN.fid.is` (PDS endpoint), and `my.fid.is` (management).

3. **Routes** are configured in `wrangler.jsonc`:
   - `fid.is/*` — apex domain
   - `*.fid.is/*` — wildcard for all subdomains

### Build and deploy

```bash
# From repository root
pnpm --filter fid-pds build && pnpm --filter fid-pds deploy
```

Vite resolves the `@fidis/pds` workspace link directly to source (`packages/pds/src/`), so you don't need to build the library separately.

### Verify

```bash
# Health check
curl https://fid.is/xrpc/_health

# DID document for FID 1898
curl https://1898.fid.is/.well-known/did.json

# PDS endpoint (note the pds- prefix)
curl https://pds-1898.fid.is/xrpc/com.atproto.sync.getRepoStatus?did=did:web:1898.fid.is
```

## API Endpoints

### FID-PDS management (`is.fid.*`)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST is.fid.account.createFarcasterMini` | Farcaster token | Create account via Quick Auth |
| `POST is.fid.account.createSiwf` | SIWF signature | Create account via Sign-In-With-Farcaster |
| `POST is.fid.account.delete` | Bearer JWT | Delete account (tombstone-preserving) |
| `GET  is.fid.account.status` | None | Check account existence + allowlist/waitlist state |
| `POST is.fid.waitlist.join` | Farcaster token / SIWF | Request early access (when allowlist enabled) |
| `POST is.fid.auth.loginFarcasterMini` | Farcaster token | Login via Quick Auth |
| `POST is.fid.auth.loginSiwf` | SIWF signature | Login via SIWF |
| `POST is.fid.account.syncRelaySeq` | Bearer JWT | Debug: advance firehose seq |
| `GET  is.fid.settings.getPdsUrl` | Bearer JWT | Get DID/PDS config |
| `POST is.fid.settings.setPdsUrl` | Bearer JWT | Set custom PDS URL + verification key |

### AT Protocol (`com.atproto.*`)

Standard AT Protocol PDS endpoints. Authenticated endpoints accept both Bearer JWT and OAuth DPoP tokens.

## Allowlist / Waitlist

Account creation can be gated behind an allowlist. When `ALLOWLIST_ENABLED` is `"true"`, only FIDs in the `allowlist` D1 table can create accounts. Everyone else sees an "Early Access" screen in the miniapp and can request access (which adds them to the `waitlist` table).

Existing accounts are never blocked — the gate only applies to new account creation.

### Setup

Run the D1 migration to create the tables (safe to re-run — uses `IF NOT EXISTS`):

```bash
wrangler d1 execute fid-pds-registry --file=schema.sql
```

### Managing the allowlist

```bash
# Add a FID to the allowlist
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) VALUES ('12345', 'admin')"

# Add multiple FIDs
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) VALUES ('111', 'admin'), ('222', 'admin')"

# Approve all waitlisted users
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) SELECT fid, 'batch' FROM waitlist"

# View the waitlist
wrangler d1 execute fid-pds-registry --command \
  "SELECT * FROM waitlist ORDER BY requested_at"

# View the allowlist
wrangler d1 execute fid-pds-registry --command \
  "SELECT * FROM allowlist ORDER BY added_at"
```

### Disabling

Set `ALLOWLIST_ENABLED` to `"false"` (or remove it) in `wrangler.jsonc` and redeploy. All FIDs will be able to create accounts.

### Debug (`gg.mk.experimental.*`)

| Endpoint | Purpose |
|----------|---------|
| `POST gg.mk.experimental.emitIdentityEvent` | Re-emit `#identity` to firehose |
| `POST gg.mk.experimental.emitAccountEvent` | Re-emit `#account` to firehose |
| `GET  gg.mk.experimental.getFirehoseStatus` | Get firehose event count and connections |
| `POST gg.mk.experimental.setRepoStatus` | Set repo status flag (debug only) |
| `POST gg.mk.experimental.resetMigration` | Reset migration state |
