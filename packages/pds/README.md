<div align="center">
    <h1>☁️</h1>
    <h1><samp>CIRRUS</samp></h1>
	<p><em>The lightest PDS in the Atmosphere</em></p>
</div>

Cirrus is a single-user [AT Protocol](https://atproto.com) Personal Data Server (PDS) that runs on Cloudflare Workers. Named for the highest, lightest clouds in a blue sky – fitting for a Bluesky server running on Cloudflare.

Host your own Bluesky identity with minimal infrastructure.

> **⚠️ Beta Software**
>
> This is under active development. Account migration has been tested and works, but breaking changes may still occur. Consider backing up important data before migrating a primary account.

## What is a PDS?

A Personal Data Server is where your Bluesky data lives – your posts, follows, profile, and media. This package lets you run your own PDS on Cloudflare Workers, giving you control over your data and identity.

Key benefits:

- **Independence from platform changes** – If Bluesky's ownership or policies change, the account remains under full control
- **Network resilience** – More independent PDS providers make the AT Protocol network stronger
- **Data sovereignty** – The repository lives on infrastructure under direct control
- **Portability** – Move between hosting providers without losing followers or identity
- **Edge performance** – Runs globally on Cloudflare's edge network

## Quick Start

```bash
pnpm create pds
# or
npm create pds
```

This scaffolds a new project, installs dependencies, and runs the setup wizard. Start the dev server:

```bash
cd pds-worker
npm run dev
```

## Manual Installation

### 1. Install the package

```bash
npm install @getcirrus/pds
```

### 2. Create a worker entry point

```typescript
// src/index.ts
export { default, AccountDurableObject } from "@getcirrus/pds";
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

## CLI Reference

The package includes a CLI for setup, migration, and secret management.

### `pds init`

Interactive setup wizard for configuring the PDS.

```bash
pds init                 # Configure the PDS (prompts for Cloudflare deploy)
```

**What it does:**

- Prompts for PDS hostname, handle, and account password
- Generates cryptographic signing keys (secp256k1)
- Creates authentication token and JWT secret
- Writes public configuration to `wrangler.jsonc`
- Saves secrets to `.dev.vars` (local) or Cloudflare (production)

For migrations, it detects existing accounts and configures the PDS in deactivated mode, ready for data import.

### `pds migrate`

Transfers account data from an existing PDS to a new one.

```bash
pds migrate              # Migrate to production PDS
pds migrate --dev        # Migrate to local development server
pds migrate --clean      # Reset and start fresh migration
```

**What it does:**

1. Resolves the DID to find the current PDS
2. Authenticates with the source PDS
3. Downloads the repository (posts, follows, likes, etc.)
4. Imports the repository to the new PDS
5. Transfers all blobs (images, videos)
6. Copies user preferences

The migration is resumable. If interrupted, run `pds migrate` again to continue.

**Flags:**

- `--dev` – Target the local development server instead of production
- `--clean` – Delete any existing imported data and start fresh (only works on deactivated accounts)

### `pds identity`

Updates your DID document to point to your new PDS. This is the critical step that tells the network where to find you.

```bash
pds identity             # Update identity for production
pds identity --dev       # Update identity for local dev
pds identity --token XXX # Skip email step if you have a token
```

The command:

1. Resolves your current DID to find the source PDS
2. Authenticates with your source PDS (requires your password)
3. Requests an email confirmation token
4. Gets the source PDS to sign a PLC operation with the new endpoint
5. Submits the signed operation to the PLC directory

**Note:** Only `did:plc` identities are supported. `did:web` identities don't use PLC operations.

### `pds activate`

Enables writes on the account after migration.

```bash
pds activate             # Activate production account
pds activate --dev       # Activate local development account
```

Run this after migrating data and updating the DID document to point to the new PDS. The account will start accepting new posts, follows, and other writes.

### `pds deactivate`

Disables writes on the account.

```bash
pds deactivate           # Deactivate production account
pds deactivate --dev     # Deactivate local development account
```

Use this before re-importing data (for example, to recover from issues). Deactivating prevents new writes during the reset and re-migration.

After deactivating:

```bash
pds migrate --clean      # Reset and re-import
pds activate             # Go live again
```

### `pds migrate-token`

Generates a migration token for migrating away from this PDS to another one.

```bash
pds migrate-token        # Generate token for production PDS
pds migrate-token --dev  # Generate token for local development PDS
```

When migrating to a new PDS, the destination will ask for a confirmation token. This command generates a stateless HMAC-based token that:

- Is valid for 15 minutes
- Contains your DID and expiry time
- Is cryptographically signed with your JWT secret
- Requires no database storage

The token is copied to your clipboard and displayed in the terminal. After migration completes, run `pds deactivate` on this PDS.

### `pds passkey`

Manage passkeys for passwordless authentication.

```bash
pds passkey add          # Register a new passkey
pds passkey list         # List registered passkeys
pds passkey remove       # Remove a passkey
```

All passkey commands support:

- `--dev` – Target the local development server instead of production

#### `pds passkey add`

Registers a new passkey (WebAuthn credential). Displays a QR code in the terminal for easy registration from a mobile device. The registration link expires after 10 minutes.

#### `pds passkey list`

Lists all registered passkeys with their names, IDs, and last used timestamps.

#### `pds passkey remove`

Interactively select and remove a passkey from the account.

### `pds secret`

Manage individual secrets.

```bash
pds secret key           # Generate new signing keypair
pds secret jwt           # Generate new JWT secret
pds secret password      # Set account password
```

All secret commands support:

- `--local` – Write to `.dev.vars` instead of Cloudflare

#### `pds secret key`

Generates a new secp256k1 signing keypair. Updates both the private key secret and the public key in your configuration.

#### `pds secret jwt`

Generates a new JWT signing secret for session tokens.

#### `pds secret password`

Prompts for a new password and stores the bcrypt hash.

## Architecture

The PDS runs as a Cloudflare Worker with a Durable Object for state:

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Hono Router                                         │    │
│  │ • Authentication middleware                         │    │
│  │ • CORS handling                                     │    │
│  │ • DID document serving                              │    │
│  │ • XRPC endpoint routing                             │    │
│  │ • OAuth 2.1 provider                                │    │
│  │ • Proxy to AppView for read endpoints               │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ AccountDurableObject                                │    │
│  │ • SQLite repository storage                         │    │
│  │ • Merkle tree for commits                           │    │
│  │ • Record indexing                                   │    │
│  │ • WebSocket firehose                                │    │
│  │ • OAuth token storage                               │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ R2 Bucket                                           │    │
│  │ • Blob storage (images, videos)                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Components

- **Worker** – Stateless edge handler for routing, authentication, and DID document serving
- **AccountDurableObject** – Single-instance SQLite storage for your AT Protocol repository. Handles all write coordination and maintains the commit history.
- **R2** – Object storage for blobs (images, videos). Blobs are content-addressed by CID.

### XRPC Proxy

For endpoints this PDS doesn't implement directly (like feed generation or notifications), requests are proxied to the Bluesky AppView. The PDS signs these requests with service authentication, so you get full Bluesky functionality without implementing every endpoint.

## Identity: DIDs and Handles

AT Protocol uses two types of identifiers:

- **DID** (Decentralized Identifier): A permanent, cryptographic identity (for example, `did:web:pds.example.com` or `did:plc:abc123`). This never changes and is tied to a signing key.
- **Handle**: A human-readable username (for example, `alice.example.com`). This can be any domain under the owner's control.

The DID document (served at `/.well-known/did.json`) contains the public key and tells the network where the PDS is. The `alsoKnownAs` field links the DID to the handle.

### Supported DID Methods

- **did:web** – Domain-based DIDs. The DID document is served by the PDS at `/.well-known/did.json`
- **did:plc** – PLC directory DIDs. Used when migrating from an existing Bluesky account

### Handle Verification

Bluesky verifies control of the handle domain. Two methods are available:

#### Option A: Handle matches PDS hostname

When the handle matches the PDS hostname (for example, both are `pds.example.com`), the PDS automatically serves `/.well-known/atproto-did` with the DID. No additional DNS setup required.

#### Option B: Handle on a different domain

For a handle on a different domain (for example, handle `alice.example.com` while PDS is at `pds.example.com`):

1. Add a DNS TXT record to the handle domain:

```
_atproto.alice.example.com  TXT  "did=did:web:pds.example.com"
```

2. Verify the record:

```bash
dig TXT _atproto.alice.example.com
```

## Configuration

The PDS uses environment variables for configuration. Public values go in `wrangler.jsonc`, secrets are stored via Wrangler or in `.dev.vars` for local development.

### Public Variables (wrangler.jsonc)

| Variable             | Description                                |
| -------------------- | ------------------------------------------ |
| `PDS_HOSTNAME`       | Public hostname (e.g., pds.example.com)    |
| `DID`                | Account DID (did:web:... or did:plc:...)   |
| `HANDLE`             | Account handle                             |
| `SIGNING_KEY_PUBLIC` | Public key for DID document (multibase)    |
| `INITIAL_ACTIVE`     | Whether account starts active (true/false) |
| `DATA_LOCATION`      | Data placement (optional, see below)       |

### Secrets

| Variable        | Description                           |
| --------------- | ------------------------------------- |
| `AUTH_TOKEN`    | Bearer token for API write operations |
| `SIGNING_KEY`   | Private signing key (secp256k1 JWK)   |
| `JWT_SECRET`    | Secret for signing session JWTs       |
| `PASSWORD_HASH` | Bcrypt hash of password for app login |

### Data Placement

Cirrus supports Cloudflare's Durable Object [data placement features](https://developers.cloudflare.com/durable-objects/reference/data-location/) for users who need control over where their data is stored. By default a durable object is created near to the first location it is accessed from. This is likely to be correct for most users. However, if you have specific data residency requirements, you can set the `DATA_LOCATION` environment variable to control where your Durable Object is placed. This only affects the location of the Durable Object instance that stores your PDS data. ATProto data is globally distributed via relays, so this does not limit access to your data from other regions.

> [!WARNING]
> Once a Durable Object is created, its location cannot be changed. Therefore, you should set `DATA_LOCATION` before the first deployment of your PDS. Changing this value after deployment will break your installation, as existing data will not be migrated.

Supported values for `DATA_LOCATION`:

- **Auto** (`auto`): Default behaviour. Cloudflare places the DO near the first access location.
- **Jurisdiction** (`eu`): Hard guarantee that data never leaves the region. Use this for compliance requirements.
- **Hints** (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`). Best-effort suggestions for initial placement region. Cloudflare may place the DO elsewhere based on availability. See [supported locations](https://developers.cloudflare.com/durable-objects/reference/data-location/#supported-locations-1) for more details)

Example in `wrangler.jsonc`:

```jsonc
{
	"vars": {
		"DATA_LOCATION": "eu",
	},
}
```

See [Cloudflare's data location documentation](https://developers.cloudflare.com/durable-objects/reference/data-location/) for more details.

## API Endpoints

### Identity

| Endpoint                       | Description                                           |
| ------------------------------ | ----------------------------------------------------- |
| `GET /.well-known/did.json`    | DID document for did:web resolution                   |
| `GET /.well-known/atproto-did` | Handle verification (only if handle matches hostname) |
| `GET /xrpc/_health`            | Health check with version info                        |

### Federation (Sync)

| Endpoint                                    | Description                                 |
| ------------------------------------------- | ------------------------------------------- |
| `GET /xrpc/com.atproto.sync.getRepo`        | Export repository as CAR file               |
| `GET /xrpc/com.atproto.sync.getRepoStatus`  | Repository status (commit, rev)             |
| `GET /xrpc/com.atproto.sync.getBlocks`      | Get specific blocks from repository         |
| `GET /xrpc/com.atproto.sync.getBlob`        | Download a blob by CID                      |
| `GET /xrpc/com.atproto.sync.listRepos`      | List repositories (single-user: just yours) |
| `GET /xrpc/com.atproto.sync.listBlobs`      | List all blobs in repository                |
| `GET /xrpc/com.atproto.sync.subscribeRepos` | WebSocket firehose for real-time updates    |

### Repository Operations

| Endpoint                                      | Auth | Description                                |
| --------------------------------------------- | ---- | ------------------------------------------ |
| `GET /xrpc/com.atproto.repo.describeRepo`     | No   | Repository metadata                        |
| `GET /xrpc/com.atproto.repo.getRecord`        | No   | Get a single record                        |
| `GET /xrpc/com.atproto.repo.listRecords`      | No   | List records in a collection               |
| `POST /xrpc/com.atproto.repo.createRecord`    | Yes  | Create a new record                        |
| `POST /xrpc/com.atproto.repo.putRecord`       | Yes  | Create or update a record                  |
| `POST /xrpc/com.atproto.repo.deleteRecord`    | Yes  | Delete a record                            |
| `POST /xrpc/com.atproto.repo.applyWrites`     | Yes  | Batch create/update/delete operations      |
| `POST /xrpc/com.atproto.repo.uploadBlob`      | Yes  | Upload an image or video                   |
| `POST /xrpc/com.atproto.repo.importRepo`      | Yes  | Import repository from CAR file            |
| `GET /xrpc/com.atproto.repo.listMissingBlobs` | Yes  | List blobs referenced but not yet uploaded |

### Server & Session

| Endpoint                                          | Auth | Description                         |
| ------------------------------------------------- | ---- | ----------------------------------- |
| `GET /xrpc/com.atproto.server.describeServer`     | No   | Server capabilities and info        |
| `POST /xrpc/com.atproto.server.createSession`     | No   | Login with password, get JWT        |
| `POST /xrpc/com.atproto.server.refreshSession`    | Yes  | Refresh JWT tokens                  |
| `GET /xrpc/com.atproto.server.getSession`         | Yes  | Get current session info            |
| `POST /xrpc/com.atproto.server.deleteSession`     | Yes  | Logout                              |
| `GET /xrpc/com.atproto.server.getServiceAuth`     | Yes  | Get JWT for external services       |
| `GET /xrpc/com.atproto.server.getAccountStatus`   | Yes  | Account status (active/deactivated) |
| `POST /xrpc/com.atproto.server.activateAccount`   | Yes  | Enable writes                       |
| `POST /xrpc/com.atproto.server.deactivateAccount` | Yes  | Disable writes                      |

### Handle Resolution

| Endpoint                                       | Description                              |
| ---------------------------------------------- | ---------------------------------------- |
| `GET /xrpc/com.atproto.identity.resolveHandle` | Resolve handle to DID (local or proxied) |

### Actor Preferences

| Endpoint                                   | Auth | Description          |
| ------------------------------------------ | ---- | -------------------- |
| `GET /xrpc/app.bsky.actor.getPreferences`  | Yes  | Get user preferences |
| `POST /xrpc/app.bsky.actor.putPreferences` | Yes  | Set user preferences |

### OAuth 2.1

The PDS includes a complete OAuth 2.1 provider for "Login with Bluesky":

| Endpoint                                      | Description                    |
| --------------------------------------------- | ------------------------------ |
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata          |
| `POST /oauth/par`                             | Pushed Authorization Request   |
| `GET /oauth/authorize`                        | Authorization endpoint         |
| `POST /oauth/authorize`                       | Process authorization decision |
| `POST /oauth/token`                           | Token exchange                 |
| `POST /oauth/revoke`                          | Token revocation               |

**Passkey support:** The authorization page supports passwordless login via passkeys (WebAuthn). If the user has registered passkeys, a "Sign in with Passkey" button appears. This works across devices – scan a QR code from your phone to authenticate on a desktop.

See the [@getcirrus/oauth-provider](../oauth-provider/) package for implementation details.

## Deploying to Production

1. **Enable R2** in your [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview). The bucket will be created automatically on first deploy.

2. **Run the setup wizard** and answer "Yes" when asked if you want to deploy to Cloudflare:

```bash
npx pds init
```

3. **Deploy your worker:**

```bash
wrangler deploy
```

4. **Configure DNS** to point your domain to the worker. In Cloudflare DNS, add a CNAME record pointing to your workers.dev subdomain, or use a custom domain in your Worker settings.

## Migration Guide

Moving an existing Bluesky account to your own PDS:

### Step 1: Configure for migration

```bash
npx pds init
# Answer "Yes" when asked about migrating an existing account
```

This detects your existing account, generates new signing keys, and configures the PDS in deactivated mode (ready for data import).

### Step 2: Deploy and transfer data

```bash
wrangler deploy
npx pds migrate
```

The migrate command:

- Resolves your DID to find the current PDS
- Authenticates with your source PDS
- Downloads the repository (posts, follows, likes, etc.)
- Transfers all blobs (images, videos)
- Copies user preferences

If interrupted, run `pds migrate` again to resume.

### Step 3: Update your identity

```bash
npx pds identity
```

This updates your DID document to point to your new PDS. The command:

1. Authenticates with your source PDS (requires password)
2. Requests an email confirmation token
3. Gets the source PDS to sign a PLC operation with your new endpoint
4. Submits the signed operation to the PLC directory

You'll receive an email with a confirmation token – enter it when prompted.

### Step 4: Activate the account

```bash
npx pds activate
```

This enables writes on your new PDS. Your account is now live.

### Step 5: Verify the migration

```bash
npx pds status
```

Check that:

- The account is active
- The repository has the expected number of records
- Your handle resolves correctly

### Full command sequence

```bash
# 1. Configure (answer "Yes" to deploy secrets to Cloudflare)
npx pds init                    # Configure for migration + deploy secrets

# 2. Deploy and migrate
wrangler deploy                 # Deploy the worker
npx pds migrate                 # Transfer data from source PDS

# 3. Update identity
npx pds identity                # Update DID document (requires email)

# 4. Go live
npx pds activate                # Enable writes

# 5. Verify
npx pds status                  # Check everything is working
```

## Validation

Records are validated against AT Protocol lexicon schemas before being stored. The PDS uses optimistic validation:

- If a schema exists for the collection, the record must pass validation
- If no schema is loaded, the record is accepted (fail-open)

This allows the PDS to accept records for new or custom collection types while still enforcing validation for known types like `app.bsky.feed.post`.

## Limitations

- **Single-user only** – One account per deployment
- **No account creation** – The owner is configured at deploy time
- **No email** – Password reset and email verification are not supported
- **No moderation** – No reporting or content moderation features

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Account Migration Guide](https://atproto.com/guides/account-migration)

## License

MIT
