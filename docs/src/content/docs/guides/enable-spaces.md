---
title: Enable spaces (alpha)
description: Turn on the atproto spaces alpha — flag, bindings, R2 lifecycle rule, KEM key — and manage spaces from the CLI and dashboard.
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

Deploy. The `com.atproto.space.*` and `com.atproto.memberspace.*` endpoints go live. With the flag off, none of those routes exist and the DID document says nothing about spaces.

## 4. Create and publish the KEM key

Syncers verify space data with a MAC derived against your `#atproto_kem` key (see [the concepts page](/concepts/spaces/#proving-data-came-from-you)). Without it, your PDS can still store and serve your own space data to you, but refuses credentialed reads that need a MAC. Create the key:

```bash
pds spaces kem
```

This stores the private key as the `SPACES_KEM_KEY` secret and its public half as the `SPACES_KEM_KEY_PUBLIC` var in `wrangler.jsonc`. Then:

- **did:web**: redeploy. Your PDS serves your DID document, which now includes `#atproto_kem`.
- **did:plc**: redeploy, then run `pds spaces kem --publish`. It asks your PDS to sign a PLC operation adding the key, which works when the PDS's signing key is one of your DID's rotation keys (true if you migrated with Cirrus). Otherwise, add the `atproto_kem` verification method with whoever holds your rotation key.

`pds spaces status` checks that the key your PDS holds is the one your DID document publishes.

## Manage spaces from the CLI

```bash
pds spaces status                # flag, schema version, counts
pds spaces list                  # every space this PDS holds data in
pds spaces create --type app.bsky.group --policy member
pds spaces members add <space-uri> <did>              # read and write
pds spaces members add <space-uri> <did> --no-write   # read only
pds spaces members remove <space-uri> <did>
pds spaces members list <space-uri>
pds spaces delete <space-uri>
pds spaces export --out ./spaces-export   # STAR archives, for migration
pds spaces kem                   # create (and with --publish, publish) the KEM key
pds spaces reset                 # wipe ALL space data (and nothing else)
```

`create` accepts `--policy personal | member | managed`. A member space takes `--public-read`, `--public-write`, repeatable `--allow <client-id>` flags to restrict which apps may read it, and `--publish-policy` / `--publish-members` to publish its configuration to readers. A managed space takes `--managing-app <did#service>`.

The dashboard at `/status` gains a **Spaces** panel showing each space's role, policy, record and member counts, with delete and member management for spaces you host. It asks for your admin token (`AUTH_TOKEN`) on first use.

## Grant apps access

Apps request access with OAuth `space:` scopes, e.g. `space:my.app.bookmarks` for the app's own space type under your authority. The consent screen shows the space type's human name and warns loudly about wildcard grants. App passwords cannot access spaces.

## Upgrading from the August alpha

The November 2026 alpha replaced simplespace with the baseline policies, credential DPoP with HTTP message signatures, and commit signatures with MACs. Space data from the earlier build can't be read by the new one. After upgrading:

1. Deploy. Space endpoints answer 503 until you reset.
2. Run `pds spaces kem` and publish the key (step 4 above).
3. Run `pds spaces reset`, then recreate your spaces.

Apps built against the earlier alpha (DPoP credentials, `com.atproto.simplespace.*`) need updating too.

## When an alpha build breaks the schema

After upgrading across an incompatible alpha build, space endpoints return a 503 pointing here, and `pds spaces status` shows which spaces are outdated. Your public repo, blobs, firehose and OAuth state are unaffected. Reset and start fresh:

```bash
pds spaces reset
```

It prints exactly what it will delete and asks for confirmation. `reset` and `status` work even while the flag is off.
