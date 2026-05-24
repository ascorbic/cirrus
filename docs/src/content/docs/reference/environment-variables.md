---
title: Environment variables
description: Public vars and secrets that Cirrus reads at startup, with what each one controls.
---

Cirrus reads its configuration from Cloudflare Worker bindings. Public values live in `wrangler.jsonc` under `vars`; secret values are Worker secrets (or `.dev.vars` locally).

The Worker validates required variables at module load. A deploy missing a required value fails fast.

## Public vars

These are visible in `wrangler.jsonc` and stored as plain Worker bindings. Edit `wrangler.jsonc` and redeploy to change them.

### `DID` (required)

The account's DID. Validated with `isDid()`. Examples:

- `did:plc:abc123def456...`
- `did:web:alice.example.com`

Set by the `pds init` wizard. Do not edit by hand unless rotating the entire identity.

### `HANDLE` (required)

The account's handle. Validated with `isHandle()`. Examples:

- `alice.example.com`
- `me.differentdomain.net`

### `PDS_HOSTNAME` (required)

The public hostname the PDS responds on. Without scheme. Example:

- `pds.example.com`

The Worker uses this to generate URLs (DID document, OAuth metadata, service endpoints).

### `SIGNING_KEY_PUBLIC` (required)

The multibase-encoded public key matching `SIGNING_KEY`. Published in the DID document for `did:web` accounts; used as a sanity check for `did:plc`.

### `INITIAL_ACTIVE` (optional, default `true`)

Whether new repositories start in the active state. Set to `false` to require an explicit `pds activate` call before the PDS accepts writes. Useful for migrations.

### `DATA_LOCATION` (optional, default `auto`)

Cloudflare location hint for the Durable Object. Values: `auto`, `eu`, `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`.

**Cannot be changed after the first deploy.** See [Data placement](/concepts/data-placement/).

## Secrets

These are Worker secrets in production and live in `.dev.vars` for local development. Set with `pnpm wrangler secret put <name>` or push from `.dev.vars` with `pnpm pds init --production`.

### `SIGNING_KEY` (required)

The secp256k1 private key used to sign repository commits and service JWTs.

**Irreplaceable.** Back it up immediately when `pds init` prints it. See [Back up your signing key](/guides/back-up-signing-key/).

### `AUTH_TOKEN` (required)

The static bearer token for admin operations. Long-lived. Used by the CLI for operator commands.

### `JWT_SECRET` (required)

HMAC-SHA256 secret for signing session JWTs. The Worker validates this at module load and refuses to start without it.

### `PASSWORD_HASH` (required)

Bcrypt hash of the account password. The Worker validates this at module load and refuses to start without it.

### `EMAIL` (optional)

The email address associated with the account. Returned in `createSession`, `refreshSession`, and `getSession` responses for clients that expect it (the official Bluesky app, deck.blue, and others). Not used for any internal flow. The `pds init` wizard prompts for it and writes it to `wrangler.jsonc`.

## Bindings (not env vars, but required)

Configured in `wrangler.jsonc` rather than as values. The Worker imports these by name.

### `ACCOUNT`

The Durable Object namespace bound to the `AccountDurableObject` class. Holds the repository SQLite database.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "ACCOUNT", "class_name": "AccountDurableObject" }
    ]
  }
}
```

### `BLOBS`

The R2 bucket for blob storage. The bucket is created on first deploy if it does not exist.

```jsonc
{
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "cirrus-blobs" }
  ]
}
```

## What happens if a required value is missing

The Worker fails at module load with a clear error naming the missing variable. The Worker does not start; requests return Cloudflare's standard error page until the value is set.

The validation is intentionally fail-fast: a half-configured PDS would emit broken commits or serve a malformed DID document, which is worse than visible downtime.

## Reading the current values

For public vars:

```bash
pnpm wrangler deployments view
```

Or check `wrangler.jsonc` directly.

For secrets, the list is visible but the values are not:

```bash
pnpm wrangler secret list
```

To replace a secret without seeing the previous value, `wrangler secret put` over the top.
