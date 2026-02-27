# miniapp

Account management UI for [fid.is](https://fid.is) — create and manage AT Protocol identities using your Farcaster account.

Runs as a **Farcaster mini app** (inside Warpcast) or as a **standalone web app** (via Sign-In-With-Farcaster in the browser).

## What It Does

1. **Account creation** — Authenticates via Farcaster, creates an AT Protocol identity (`did:web:NNN.fid.is`), and populates the Bluesky profile from Farcaster data.
2. **Identity settings** — Configure custom PDS URL and verification key in the DID document (for migration or self-hosting).
3. **Account lifecycle** — Activate, deactivate, or delete the AT Protocol account.
4. **Debug tools** — Inspect DID documents, repo status, firehose events, and relay sync state.

## Authentication Modes

The app supports two authentication flows depending on the environment:

| Mode | Entry point | How it works |
|------|-------------|--------------|
| **Mini app** (Warpcast) | Farcaster Quick Auth | `@farcaster/miniapp-sdk` calls `sdk.quickAuth.getToken()` to get a JWT with the user's FID |
| **Browser** | Sign-In-With-Farcaster | `@farcaster/auth-kit` renders a QR code / deep link for SIWF signature verification |

Both flows extract the user's FID, then call the fid-pds API at `https://pds-NNN.fid.is` to create or log into the account.

## Farcaster Profile Population

On account creation, the miniapp fetches the user's Farcaster profile and writes it to the AT Protocol `app.bsky.actor.profile` record. This is best-effort — failures don't block account creation.

### External Services

Two external services are queried **client-side** in parallel:

| Service | URL | Data fetched |
|---------|-----|--------------|
| **Farcaster Hub API** | `https://haatz.quilibrium.com/v1/userDataByFid?fid={fid}` | Display name, bio, avatar URL, username, URL, Ethereum address |
| **FNAME Registry** | `https://fnames.farcaster.xyz/transfers?fid={fid}` | Farcaster name (fname) — the most recent transfer for the FID |

### Profile Mapping

| Farcaster field | Hub message type | AT Protocol field |
|-----------------|------------------|-------------------|
| Display name | `USER_DATA_TYPE_DISPLAY` | `displayName` (truncated to 64 chars) |
| Bio | `USER_DATA_TYPE_BIO` | `description` (truncated to 256 chars) |
| Avatar | `USER_DATA_TYPE_PFP` | Downloaded, uploaded as blob, set as `avatar` |
| Username | `USER_DATA_TYPE_USERNAME` | Stored locally (not written to AT Proto) |
| URL | `USER_DATA_TYPE_URL` | Stored locally (not written to AT Proto) |
| Ethereum address | `USER_DATA_TYPE_PRIMARY_ADDRESS_ETHEREUM` | Stored locally (not written to AT Proto) |

Avatar upload constraints: max 1MB, must be JPEG, PNG, or WebP (detected via magic bytes).

## API Communication

All API calls target the user's PDS subdomain (`https://pds-NNN.fid.is`), never the bare domain.

- **Pre-auth** calls (account status, login, create) use `pdsUrl(fid)` → `https://pds-{fid}.{DOMAIN}`
- **Post-auth** calls (settings, debug, delete) use `pdsBaseFromHandle(session.handle)` → `https://pds-{handle}`
- **Relay queries** (getHostStatus, requestCrawl) target the PDS hostname `pds-NNN.fid.is`

### Relay Integration

The miniapp communicates with Bluesky relays for sync operations:

| Relay URL | Purpose |
|-----------|---------|
| `https://bsky.network` | Request crawl (primary relay) |
| `https://relay1.us-west.bsky.network` | Request crawl + query host status |
| `https://relay1.us-east.bsky.network` | Request crawl + query host status |

## Environment Variables

All environment variables are prefixed with `VITE_` (Vite convention — exposed to client-side code).

### Required

| Variable | Example | Purpose |
|----------|---------|---------|
| `VITE_PDS_DOMAIN` | `fid.is` | Base domain for constructing PDS API URLs. The miniapp calls `https://pds-{fid}.{DOMAIN}/xrpc/...` |
| `VITE_AUTH_DOMAIN` | `fid.is` | Domain for SIWF verification. Must match the PDS's `WEBFID_DOMAIN`. |
| `VITE_AUTH_URI` | `https://fid.is` | SIWE URI for SIWF. Protocol + domain. |

### Configuration Files

| File | Purpose |
|------|---------|
| `.env.development` | Development defaults (checked in) |
| `.env.production` | Production values (create for deploy) |
| `public/.well-known/farcaster.json` | Farcaster mini app manifest — contains `accountAssociation` (signed by the deployer's FID custody key) and mini app metadata |

### Example `.env.development`

```bash
# PDS domain — where API calls are sent
VITE_PDS_DOMAIN=fid.is

# SIWF auth domain — must match PDS's WEBFID_DOMAIN
VITE_AUTH_DOMAIN=fid.is
VITE_AUTH_URI=https://fid.is
```

For local development with tunnels:

```bash
VITE_PDS_DOMAIN=your-pds-tunnel.trycloudflare.com
VITE_AUTH_DOMAIN=your-pds-tunnel.trycloudflare.com
VITE_AUTH_URI=https://your-pds-tunnel.trycloudflare.com
```

## Development

```bash
# Install dependencies
pnpm install

# Start dev server (port 5173)
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

### Testing with Farcaster

To test the mini app flow in Warpcast, you need a tunnel to your local dev server:

```bash
cloudflared tunnel --url http://localhost:5173
```

Then update `public/.well-known/farcaster.json` with:
- `homeUrl` pointing to your tunnel URL
- A fresh `accountAssociation` signed with your FID's custody key

### Testing SIWF in browser

The browser flow works locally without a tunnel — just visit `http://localhost:5173`. The SIWF QR code will appear for authentication.

Note: `VITE_AUTH_DOMAIN` and `VITE_AUTH_URI` must match the PDS's `WEBFID_DOMAIN` for SIWF signature verification to succeed.

## Deployment

The miniapp is a static site (React SPA). Deploy the `dist/` output to any static hosting:

```bash
pnpm build
# Deploy dist/ to Cloudflare Pages, Vercel, Netlify, etc.
```

### Farcaster Mini App Registration

The `public/.well-known/farcaster.json` manifest must be served at the miniapp's domain. It contains:

- **`accountAssociation`** — cryptographic proof linking the domain to a Farcaster FID. Generated by signing the domain with the FID's custody key.
- **`miniapp`** — metadata (name, icon, description) displayed in Warpcast's mini app directory.

## Project Structure

```
apps/miniapp/
  src/
    App.tsx          ← Main UI component (auth flows, settings, debug page)
    api.ts           ← API client (all PDS + external service calls)
    index.css        ← Styles
    main.tsx         ← React entry point
    vite-env.d.ts    ← Vite environment type declarations
  public/
    .well-known/
      farcaster.json ← Mini app manifest
  index.html         ← HTML shell
  vite.config.ts     ← Vite configuration
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@farcaster/miniapp-sdk` | Mini app SDK — `sdk.quickAuth.getToken()` for Quick Auth, `sdk.actions.ready()` for lifecycle |
| `@farcaster/auth-kit` | Sign-In-With-Farcaster — `<SignInButton>` component for browser auth flow |
| `react` / `react-dom` | UI framework |
