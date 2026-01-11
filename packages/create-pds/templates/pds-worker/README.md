# Your Personal PDS

A single-user AT Protocol Personal Data Server running on Cloudflare Workers.

> **⚠️ Beta Software**
>
> This is under active development. Account migration has been tested and works, but breaking changes may still occur. Consider backing up important data before migrating a primary account.

## Getting Started

### 1. Install dependencies

```bash
pnpm install
# or: npm install / yarn install
```

### 2. Configure the PDS

Run the setup wizard if not already done:

```bash
pnpm pds init
```

This prompts for:
- **PDS hostname** – The deployment domain (e.g., `pds.example.com`)
- **Handle** – The Bluesky username (e.g., `alice.example.com`)
- **Password** – For logging in from Bluesky apps

The wizard generates cryptographic keys and writes configuration to `.dev.vars` and `wrangler.jsonc`.

### 3. Run locally

```bash
pnpm dev
```

The PDS is now running at http://localhost:5173. Test it with:

```bash
curl http://localhost:5173/health
curl http://localhost:5173/.well-known/did.json
```

### 4. Deploy to production

When running `pds init`, answer "Yes" when asked if you want to deploy to Cloudflare. This pushes secrets to Cloudflare Workers.

Then deploy the worker:

```bash
pnpm run deploy
```

Finally, configure DNS to point your domain to the worker.

## Migrating an Existing Account

To move an existing Bluesky account from bsky.social or another PDS:

### Step 1: Configure for migration

```bash
pnpm pds init
# Answer "Yes" when asked about migrating an existing account
```

This detects your existing account, generates new signing keys, and configures the PDS in deactivated mode.

### Step 2: Deploy and transfer data

```bash
pnpm run deploy                  # Deploy the worker
pnpm pds migrate                 # Transfer data from source PDS
```

The migrate command downloads the repository (posts, follows, likes) and all images/videos from the current PDS. If interrupted, run it again to resume.

### Step 3: Update your identity

```bash
pnpm pds identity
```

This updates your DID document to point to your new PDS. You'll need to:
1. Enter your password for the source PDS
2. Enter the confirmation token sent to your email

### Step 4: Activate the account

```bash
pnpm pds activate
```

This enables writes on your new PDS. Your account is now live.

### Step 5: Verify the migration

```bash
pnpm pds status
```

Check that the account is active and your handle resolves correctly.

### Full command sequence

```bash
pnpm pds init                    # Configure + deploy secrets (answer "Yes" to deploy)
pnpm run deploy                  # Deploy the worker
pnpm pds migrate                 # Transfer data from source PDS
pnpm pds identity                # Update DID document (requires email)
pnpm pds activate                # Enable writes
pnpm pds status                  # Verify everything is working
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `pnpm pds init` | Interactive setup wizard (prompts for Cloudflare deploy) |
| `pnpm pds migrate` | Transfer account from source PDS |
| `pnpm pds migrate --clean` | Reset and re-import data |
| `pnpm pds identity` | Update DID document to point to new PDS |
| `pnpm pds activate` | Enable writes (go live) |
| `pnpm pds deactivate` | Disable writes (for re-import) |
| `pnpm pds status` | Check account and repository status |
| `pnpm pds passkey add` | Register a passkey for passwordless login |
| `pnpm pds secret key` | Generate new signing keypair |
| `pnpm pds secret jwt` | Generate new JWT secret |
| `pnpm pds secret password` | Set account password |

Add `--dev` to target your local development server instead of production.

## Configuration

### Public Variables (wrangler.jsonc)

| Variable | Description |
|----------|-------------|
| `PDS_HOSTNAME` | Public hostname (e.g., pds.example.com) |
| `DID` | Account DID |
| `HANDLE` | Account handle |
| `SIGNING_KEY_PUBLIC` | Public key for DID document |

### Secrets (.dev.vars or Cloudflare)

| Variable | Description |
|----------|-------------|
| `AUTH_TOKEN` | Bearer token for API write operations |
| `SIGNING_KEY` | Private signing key |
| `JWT_SECRET` | Secret for session tokens |
| `PASSWORD_HASH` | Bcrypt hash of the account password |

## Handle Verification

Bluesky verifies control of the handle domain.

**If the handle matches the PDS hostname** (for example, both are `pds.example.com`):
- No extra setup needed. The PDS handles verification automatically.

**If the handle is on a different domain** (for example, handle `alice.example.com`, PDS at `pds.example.com`):

Add a DNS TXT record:

```
_atproto.alice.example.com  TXT  "did=did:web:pds.example.com"
```

Verify with:

```bash
dig TXT _atproto.alice.example.com
```

## Project Structure

```
├── src/
│   └── index.ts          # Worker entry point (re-exports PDS)
├── wrangler.jsonc        # Cloudflare Worker configuration
├── .dev.vars             # Local secrets (not committed)
└── package.json
```

## Troubleshooting

### "PDS not responding"

Ensure the worker is deployed (`pnpm run deploy`) or the dev server is running (`pnpm dev`).

### "Failed to resolve handle"

Check the handle configuration:
- For DNS verification: ensure the TXT record has propagated (`dig TXT _atproto.yourhandle.com`)
- For same-domain handles: ensure the PDS is accessible at `https://yourdomain.com/.well-known/atproto-did`

### Migration issues

If migration fails partway through:
- Run `pnpm pds migrate` again to resume from where you left off
- Use `pnpm pds migrate --clean` to start fresh (only on deactivated accounts)

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [@getcirrus/pds Documentation](https://github.com/ascorbic/cirrus/tree/main/packages/pds)
- [Account Migration Guide](https://atproto.com/guides/account-migration)

## License

MIT
