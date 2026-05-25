---
title: Choose a handle
description: How handle verification works, the two methods Cirrus supports, and how to set up each.
---

A handle is the human-readable name for an account: `alice.example.com`. Handles use DNS-style syntax because they are verified through DNS or HTTPS.

Cirrus supports two verification methods. The choice depends on whether the handle's domain is the same as the PDS's hostname.

## Same-host handles

If the handle shares its domain with the PDS, no DNS configuration is needed.

For example, with PDS hostname `alice.example.com` and handle `alice.example.com`:

- Cirrus serves `https://alice.example.com/.well-known/atproto-did` automatically.
- The network resolves the handle by fetching that URL.

This is the simplest setup. The wizard configures it automatically when the handle and the PDS hostname match.

## Cross-host handles

If the handle is on a different domain from the PDS, DNS verification is required.

For example, with PDS hostname `pds.example.com` and handle `alice.differentdomain.net`:

1. Add a TXT record on the handle's domain:
   ```
   _atproto.alice.differentdomain.net  TXT  "did=did:plc:abc123..."
   ```
2. Wait for DNS propagation (usually minutes, up to 24 hours).
3. Confirm with `pds status` or by querying `com.atproto.identity.resolveHandle`.

The DID in the TXT record must match the account DID exactly.

## Verifying handle resolution

The fastest check:

```bash
pnpm pds status
```

The output shows the configured handle and whether it resolves. A green check on **Handle resolves** confirms success.

For a manual check, query the resolver:

```bash
curl "https://pds.example.com/xrpc/com.atproto.identity.resolveHandle?handle=alice.example.com"
```

The response is `{"did": "did:..."}`. The returned DID must match the account DID.

## Changing the handle

For `did:plc` accounts, the handle can be changed without affecting the DID:

1. Set up the new handle (DNS TXT record or same-host file) so it resolves to the existing DID.
2. Update the handle on Cirrus by editing `HANDLE` in `wrangler.jsonc` and redeploying.
3. Submit a PLC operation to update the DID document's `alsoKnownAs` entry. The Bluesky app's settings page can do this. Otherwise, submit the operation directly to `plc.directory` — see the [PLC method spec](https://github.com/did-method-plc/did-method-plc).

## Picking a good handle

- **Use a domain that will last.** The handle is the public-facing name. Losing the domain means losing the handle.
- **Use a domain controlled by the account holder.** Handles on third-party domains (a free subdomain service) can be revoked.
- **Match the handle to the PDS hostname** when starting from scratch. It eliminates the DNS step and keeps the configuration simple.

## What handles cannot do

- A handle cannot collide with an existing one: handles are unique across the AT Protocol network. Bluesky's namespace conventions apply.
- A handle is not the account's identity; the DID is. A leaked or stolen handle is recoverable. A lost signing key is not. See [Identity and your signing key](/concepts/identity/).
