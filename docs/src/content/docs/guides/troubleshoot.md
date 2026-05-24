---
title: Troubleshoot common errors
description: Recipes for the failures most likely to show up during install, migration, or daily operation.
---

This page is organised by symptom. Find the symptom, follow the recipe. For deeper background, the linked concept pages explain why.

## Handle does not resolve

**Symptom:** `pds status` reports **Handle does not resolve**, or `com.atproto.identity.resolveHandle` returns an error.

**Check the DNS or same-host file:**

```bash
# Same-host handle:
curl https://<handle>/.well-known/atproto-did

# Cross-host handle:
dig +short TXT _atproto.<handle>
```

The same-host file should return the DID as plain text. The TXT record should contain `did=did:...`.

**Common causes:**

- DNS has not propagated. Wait. Check from a different network.
- The TXT record's DID does not match the account DID. Compare `pds status` against the TXT record.
- The same-host file is not being served. Cirrus serves this automatically — if it is missing, the deploy is broken. Run `pds status` and check the Worker logs in the Cloudflare dashboard.

For background, see [Choose a handle](/guides/choose-a-handle/).

## Key recovery required

**Symptom:** `pds init` exits with **Key Recovery Required**.

**Cause:** the project directory does not contain the signing key, and Cirrus refuses to overwrite an existing deployment with a fresh key.

**Recipe:**

1. Find the backed-up signing key.
2. Add it to `.dev.vars`:
   ```
   SIGNING_KEY=<the backed-up key>
   ```
3. Re-run `pnpm pds init`. The wizard detects the key, verifies it matches the DID document, and continues.

If the key is genuinely lost, see [Back up your signing key](/guides/back-up-signing-key/) for recovery options by DID method.

## Cannot sign in to the Bluesky app

**Symptom:** the Bluesky app returns **Invalid handle or password** or **Could not connect to PDS**.

**Checks:**

```bash
curl https://pds.example.com/xrpc/com.atproto.server.describeServer
```

If the PDS does not respond, the deployment is down. Check the Cloudflare dashboard for Worker errors.

```bash
pnpm pds status
```

If the handle does not resolve, fix that first (see above).

**If the PDS responds and the handle resolves but the password is rejected:** set a new password.

```bash
pnpm pds secret password
```

This pushes a new `PASSWORD_HASH` to Cloudflare. Sign in with the new password.

## Blob upload fails

**Symptom:** `uploadBlob` returns a 413 or 400 error.

**Common causes:**

- The blob is larger than 60 MB. This limit is enforced by Cirrus. Compress or resize the media.
- The R2 bucket is not bound. Check `wrangler.jsonc` for the `BLOBS` binding. Redeploy if missing.
- R2 is not enabled on the Cloudflare account. Enable it in the dashboard.

## Firehose subscriber stalls

**Symptom:** a subscriber to `com.atproto.sync.subscribeRepos` stops receiving events.

**Recipe:**

- Reconnect with a cursor. The subscriber should track the last received `seq` and pass it as `cursor` on reconnect.
- Check the WebSocket connection state. Cloudflare hibernates idle connections; a well-behaved client reconnects on close.
- Confirm events are being produced. Create a record and watch for an event.

For the wire format, see [The firehose](/concepts/firehose/).

## DID document is stale or wrong

**Symptom:** the network resolves the account to an old PDS or the wrong signing key.

**For `did:plc`:**

```bash
curl https://plc.directory/<did>
```

The returned document should list the Cirrus hostname and the current public key. If it does not, the PLC operation did not land — re-run `pnpm pds identity`.

**For `did:web`:**

```bash
curl https://<domain>/.well-known/did.json
```

Cirrus serves this from the Worker. If the public key is wrong, update `SIGNING_KEY_PUBLIC` (a `var` in `wrangler.jsonc`) so it matches the active `SIGNING_KEY`. If the hostname or handle is wrong, fix the corresponding `vars` entry. Redeploy with `pnpm run deploy`.

## Migration fails partway through

**Symptom:** `pds migrate` errors out during repository or blob transfer.

**Recipe:**

- Re-run `pnpm pds migrate`. The CLI resumes from the last checkpoint.
- If the checkpoint is corrupt, run with `--clean` to start over. The target PDS is in a half-imported state until the migration completes.

The source account is not affected until the PLC rotation lands.

## Cloudflare deploy fails

**Symptom:** `wrangler deploy` returns an error.

**Common causes:**

- Not authenticated. Run `pnpm wrangler login`.
- The R2 bucket name is taken (R2 bucket names are global). Edit `wrangler.jsonc` to use a different name.
- The Durable Object migration is missing. The first deploy creates the Durable Object class; subsequent renames or removals need a `migrations` block in `wrangler.jsonc`. See [the wrangler.jsonc reference](/reference/wrangler-config/).

## When all else fails

- Check the Cloudflare dashboard's Worker logs for runtime errors.
- Check the [GitHub issues](https://github.com/ascorbic/cirrus/issues) for a matching report.
- Open a new issue with the Worker logs, the `pds status` output, and the version of `@getcirrus/pds` in use.
