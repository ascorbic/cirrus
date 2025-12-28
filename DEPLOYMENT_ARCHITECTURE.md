# PDS Deployment Architecture

## Design Decision: Zero-Code Re-Export Pattern

For maximum simplicity, users deploying a PDS should not need to write any code. The `@ascorbic/pds-worker` package provides everything needed, and users simply re-export it.

### Rationale

1. **Single-user PDS**: This is not a multi-tenant platform. Each deployment serves one account.
2. **Configuration via environment**: All customization (DID, keys, hostname) is already environment-based.
3. **No code needed**: Users shouldn't have to understand Hono, Durable Objects, or Workers APIs to deploy.
4. **Future-proof**: If customization is needed later, we can add a factory function without breaking changes.

## User's Worker Structure

```typescript
// src/index.ts (user's worker)
export { default, AccountDurableObject } from "@ascorbic/pds-worker";
```

That's it. No additional code required.

## Package Exports

The `@ascorbic/pds-worker` package exports:

```typescript
// packages/pds/src/index.ts
export { SqliteRepoStorage } from "./storage";
export { AccountDurableObject } from "./account-do";
export { BlobStore } from "./blobs";

// Default export: configured Hono app
export default app;
```

## Configuration

All configuration is via environment variables and secrets:

**Required environment variables:**

- `PDS_HOSTNAME` - Public hostname (e.g., "pds.example.com")

**Required secrets (set via `wrangler secret put`):**

- `DID` - The account's DID (e.g., "did:web:pds.example.com")
- `HANDLE` - The account's handle (e.g., "alice.pds.example.com")
- `AUTH_TOKEN` - Bearer token for write operations
- `SIGNING_KEY` - Private key for signing commits
- `SIGNING_KEY_PUBLIC` - Public key for DID document

**Resource bindings (in wrangler.jsonc):**

- `ACCOUNT` - DurableObjectNamespace binding
- `BLOBS` - R2Bucket binding

## Deployment Workflow

### Initial Setup (via `create-pds` CLI)

```bash
npm create @ascorbic/pds my-pds
cd my-pds
npm install
```

This scaffolds:

```
my-pds/
├── src/
│   └── index.ts          # Re-exports @ascorbic/pds-worker
├── wrangler.jsonc        # Worker config with bindings
├── package.json          # Dependencies
├── .env.example          # Template for required vars
├── .gitignore           # Ignore .env, .dev.vars, etc.
└── README.md            # Setup instructions
```

### Bootstrap Script

```bash
npm run setup
```

This interactive script:

1. Prompts for hostname and handle
2. Generates secp256k1 keypair
3. Creates DID (did:web based on hostname)
4. Generates random AUTH_TOKEN
5. Writes to `.dev.vars` for local dev
6. Provides commands to set secrets for production

### Local Development

```bash
npm run dev
```

Uses `.dev.vars` for local testing with Miniflare.

### Deployment

```bash
npm run deploy
```

Deploys to Cloudflare Workers. User must have set secrets first:

```bash
wrangler secret put DID
wrangler secret put HANDLE
wrangler secret put AUTH_TOKEN
wrangler secret put SIGNING_KEY
wrangler secret put SIGNING_KEY_PUBLIC
```

### R2 Bucket Setup

The R2 bucket must be created manually (or we provide a setup command):

```bash
wrangler r2 bucket create pds-blobs
```

Or auto-provision via Dashboard API (requires additional permissions).

## Package Structure

```
atproto-worker/
├── packages/
│   ├── pds/                    # @ascorbic/pds-worker
│   │   ├── src/
│   │   │   ├── index.ts       # Exports app + AccountDurableObject
│   │   │   ├── account-do.ts
│   │   │   ├── storage.ts
│   │   │   ├── blobs.ts
│   │   │   └── ...
│   │   └── package.json
│   └── create-pds/            # @ascorbic/create-pds
│       ├── src/
│       │   ├── cli.ts         # CLI entry point
│       │   ├── scaffold.ts    # Project scaffolding
│       │   ├── keygen.ts      # Keypair generation
│       │   └── templates/     # Project templates
│       └── package.json
└── demos/
    └── pds/                   # Example deployment (for testing)
        ├── src/
        │   └── index.ts       # Re-exports @ascorbic/pds-worker
        ├── wrangler.jsonc
        └── package.json
```

## Migration Path for Customization

If users need customization in the future, we can provide a factory function:

```typescript
// Future API (backward compatible)
import { createPDS } from "@ascorbic/pds-worker";

export default createPDS({
	// Custom middleware, rate limiting, etc.
	beforeAuth: async (c, next) => {
		// Custom logic
		await next();
	},
});

export { AccountDurableObject } from "@ascorbic/pds-worker";
```

This would be a non-breaking addition to the API.

## Comparison with Other Approaches

| Approach                 | Pros                        | Cons                              | Decision                        |
| ------------------------ | --------------------------- | --------------------------------- | ------------------------------- |
| Re-export                | Dead simple, no code needed | No customization                  | ✅ **Chosen for MVP**           |
| Factory function         | Allows config, still simple | Requires understanding config API | Future enhancement              |
| Mount on user's Hono app | Maximum flexibility         | User must know Hono/Workers       | Too complex for target audience |

## Implementation Checklist

- [x] Package exports configured properly
- [ ] Demo worker using re-export pattern
- [ ] Setup script for key generation
- [ ] `create-pds` CLI tool
- [ ] Template files for scaffolding
- [ ] Documentation for deployment
- [ ] Auto-provisioning for R2 bucket (optional)
