---
title: wrangler.jsonc
description: The Cloudflare Worker config file Cirrus uses, with every field explained.
---

`wrangler.jsonc` is the Cloudflare Workers configuration. The scaffolded project ships with a pre-filled version. This page documents what each field controls.

## Example

The scaffolded `wrangler.jsonc` ships with placeholder values that `pds init` fills in. After running the wizard it looks roughly like this:

```jsonc
{
  "name": "alice-pds",
  "main": "src/index.ts",
  "compatibility_date": "2025-12-02",
  "compatibility_flags": ["nodejs_compat"],

  "vars": {
    "PDS_HOSTNAME": "pds.example.com",
    "DID": "did:plc:abc123...",
    "HANDLE": "alice.example.com",
    "DATA_LOCATION": "wnam",
    "SIGNING_KEY_PUBLIC": "zQ3sh...",
    "INITIAL_ACTIVE": "true"
  },

  "durable_objects": {
    "bindings": [
      { "name": "ACCOUNT", "class_name": "AccountDurableObject" }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["AccountDurableObject"]
    }
  ],

  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "pds-blobs" }
  ],

  "routes": [
    { "pattern": "pds.example.com", "custom_domain": true }
  ],

  "observability": {
    "enabled": true
  }
}
```

The scaffolded template only includes `PDS_HOSTNAME`, `DID`, `HANDLE`, and `DATA_LOCATION` under `vars` (all blank). `SIGNING_KEY_PUBLIC` and `INITIAL_ACTIVE` are added by `pds init`, along with the worker `name`, the `routes` block, and the Cloudflare `account_id` (when more than one account is linked).

## Top-level fields

### `name`

The Worker's name. Shows up in the Cloudflare dashboard. Used as the prefix for the `*.workers.dev` URL.

Pick something unique to the account.

### `main`

Entry point for the Worker. Always `src/index.ts` in a scaffolded project. The file re-exports the Cirrus Worker from `@getcirrus/pds`.

### `compatibility_date`

The compatibility date for Cloudflare Workers runtime features. Cirrus requires at least `2024-04-03` for Durable Object RPC. Newer dates pick up newer runtime features. The scaffolder sets a recent date.

### `compatibility_flags`

Runtime feature flags. Cirrus needs `nodejs_compat` for some npm dependencies.

## Vars

The `vars` block holds non-secret configuration. See [Environment variables](/reference/environment-variables/) for what each one means.

Changing `vars` requires a redeploy. Cloudflare does not hot-reload.

## Durable Object bindings

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "ACCOUNT", "class_name": "AccountDurableObject" }
  ]
}
```

The `name` is what the Worker code uses to look up the binding (`env.ACCOUNT`). The `class_name` matches the exported class in the Worker.

Cirrus exports `AccountDurableObject` from its main entry. Do not rename the binding without coordinating with the Cirrus code.

## Migrations

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["AccountDurableObject"]
  }
]
```

The migrations block declares Durable Object class changes over time. `new_sqlite_classes` means the class uses Cloudflare's SQLite-backed Durable Objects (required for Cirrus).

Adding a new migration block is necessary for renaming or removing the class. For ordinary updates of Cirrus, no migration changes are needed.

## R2 buckets

```jsonc
"r2_buckets": [
  { "binding": "BLOBS", "bucket_name": "alice-pds-blobs" }
]
```

The `binding` is what the Worker uses (`env.BLOBS`). The `bucket_name` is the R2 bucket — bucket names are global across all of Cloudflare. Pick a unique name.

The bucket is created on first deploy if it does not exist.

## Routes

```jsonc
"routes": [
  { "pattern": "pds.example.com", "custom_domain": true }
]
```

`pds init` writes a custom-domain route for the configured hostname. The `custom_domain: true` form provisions a TLS certificate automatically and does not require a `zone_name`.

## Observability

```jsonc
"observability": {
  "enabled": true
}
```

Enables Cloudflare's Workers Logs. Required to see Cirrus's log output in the dashboard. No reason to disable for normal operation.

## Things to avoid changing

- **The `ACCOUNT` Durable Object binding name.** Cirrus reads `env.ACCOUNT` by that exact name.
- **The `BLOBS` R2 binding name.** Cirrus reads `env.BLOBS` by that exact name.
- **`new_sqlite_classes`.** Cirrus depends on SQLite-backed Durable Objects.

## Things safe to change

- The Worker name (`name`).
- The R2 bucket name (`r2_buckets[].bucket_name`) — but only before the first deploy. After that, changing the bucket name means the existing blobs are orphaned.
- The compatibility date, with care.
- Adding additional routes or custom domains.
- Enabling Cloudflare Access on specific paths.

For more on Cloudflare Workers configuration, see [the Wrangler docs](https://developers.cloudflare.com/workers/wrangler/configuration/).
