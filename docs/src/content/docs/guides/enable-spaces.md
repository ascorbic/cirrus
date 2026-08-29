---
title: Enable spaces (alpha)
description: Turn on the atproto spaces alpha — flag, bindings, R2 lifecycle rule — and manage spaces from the CLI and dashboard.
---

Spaces are **alpha**. Read [the concepts page](/concepts/spaces/) first, especially the caveats: breaking upstream changes are absorbed by wiping space data, and nothing else.

## Prerequisites

- A deployed Cirrus PDS on `@getcirrus/pds` ≥ the first spaces release.
- Blob storage (the `BLOBS` R2 bucket) if you want blobs in spaces.

## 1. Add the Durable Object bindings

New projects scaffolded by `create-pds` already have these. Existing deployments need the two space classes in `wrangler.jsonc`:

```jsonc
"durable_objects": {
	"bindings": [
		{ "name": "ACCOUNT", "class_name": "AccountDurableObject" },
		{ "name": "SPACES", "class_name": "SpaceDurableObject" },
		{ "name": "SPACES_INDEX", "class_name": "SpaceIndexDurableObject" }
	]
},
"migrations": [
	{ "tag": "v1", "new_sqlite_classes": ["AccountDurableObject"] },
	{ "tag": "v2", "new_sqlite_classes": ["SpaceDurableObject", "SpaceIndexDurableObject"] }
]
```

If your worker entry re-exports from `@getcirrus/pds`, export the new classes too:

```ts
export {
	default,
	AccountDurableObject,
	SpaceDurableObject,
	SpaceIndexDurableObject,
} from "@getcirrus/pds";
```

The `v2` migration is additive and safe to deploy whether or not you enable the flag.

## 2. Add the R2 lifecycle rule

Blob uploads are staged under `<did>/staged/` until a record references them. Abandoned uploads should expire:

```bash
wrangler r2 bucket lifecycle add pds-blobs --prefix "<your-did>/staged/" --expire-days 7
```

Replace `pds-blobs` with your bucket name and `<your-did>` with your DID.

## 3. Turn on the flag

In `wrangler.jsonc`:

```jsonc
"vars": {
	// ...
	"SPACES_ENABLED": "true"
}
```

Deploy. Your DID document gains an `#atproto_space_host` service entry, and the `com.atproto.space.*` and `com.atproto.simplespace.*` endpoints go live. With the flag off, none of those routes exist and the DID document says nothing about spaces.

## Manage spaces from the CLI

```bash
pds spaces status                # flag, schema version, counts
pds spaces list                  # every space this PDS holds data in
pds spaces create --type app.bsky.group --policy member-list
pds spaces members add <space-uri> <did>
pds spaces members remove <space-uri> <did>
pds spaces members list <space-uri>
pds spaces delete <space-uri>
pds spaces export --out ./spaces-export   # one CAR per space
pds spaces reset                 # wipe ALL space data (and nothing else)
```

`create` accepts `--policy public | member-list | managing-app` (with `--managing-app <did#service>`), and repeatable `--allow <client-id>` flags to restrict which apps may access the space.

The dashboard at `/status` gains a **Spaces** panel showing each space's role, record and member counts, with delete and member management for spaces you host. It asks for your admin token (`AUTH_TOKEN`) on first use.

## Grant apps access

Apps request access with OAuth `space:` scopes, e.g. `space:my.app.bookmarks` for the app's own space type under your authority. The consent screen shows the space type's human name and warns loudly about wildcard grants. App passwords cannot access spaces.

## When an alpha build breaks the schema

After upgrading across an incompatible alpha build, space endpoints return a 503 pointing here, and `pds spaces status` shows which spaces are outdated. Your public repo, blobs, firehose and OAuth state are unaffected. Reset and start fresh:

```bash
pds spaces reset
```

It prints exactly what it will delete and asks for confirmation. `reset` and `status` work even while the flag is off.
