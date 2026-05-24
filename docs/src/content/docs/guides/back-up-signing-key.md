---
title: Back up your signing key
description: How to back up the signing key, how to restore it, and what to do if it is lost.
---

The signing key is the irreplaceable part of a Cirrus deployment. Everything else — the Worker code, the Durable Object's storage, the R2 bucket, the DNS records — can be reconstructed. The signing key cannot. For the conceptual background, see [Identity and your signing key](/concepts/identity/).

This guide covers backup, restore, and recovery in practical terms.

## When the wizard prints the key

`pds init` generates the signing key and prints it once, immediately, with a `SIGNING_KEY=...` line that includes the full private key. The same value is written to `.dev.vars` for local development.

This is the moment to back up. The key cannot be retrieved from Cloudflare after `pds init --production` sets it as a Worker secret.

## How to back up

A backup is anything that holds the `SIGNING_KEY` value and is recoverable independently of the original machine. Reasonable choices:

- **A password manager** (1Password, Bitwarden, KeePass). Create an entry named after the account; store the key in the password field; store the DID in the URL field.
- **An encrypted file.** Use `age`, `gpg`, or any modern symmetric tool. Store the encrypted file in cloud backup.
- **A printed copy in a secure location.** The key is a base64-ish string; it fits on a piece of paper.

The backup needs to be:

- **Recoverable from a different device.** A copy on the same laptop that holds `.dev.vars` is not a backup.
- **Readable by the account holder, alone.** The key grants full control of the account; treat it like a high-value password.
- **Versioned if it changes.** If the key is rotated (see [Manage secrets and rotate keys](/operate/secrets/)), back up the new key.

## How to restore

When restoring to a new machine — for example, after cloning the project repository — `pds init` detects that the deploy already exists and prompts for the key.

1. Clone the project repository.
2. Run `pnpm install`.
3. Create `.dev.vars` (or edit the existing one) and add the line `SIGNING_KEY=<the backed-up key>`.
4. Run `pnpm pds init`.

The wizard reads the existing key from `.dev.vars`, verifies that it matches the public key in the DID document, and continues the configuration.

If `.dev.vars` does not exist and no key is found, the wizard reports **Key Recovery Required** and exits.

## Verifying a backup

A backup that has not been tested is not a backup. Verify it by setting up the project from scratch on a different machine, restoring the key, and running:

```bash
pnpm pds status
```

A successful run confirms the key matches the public key in the DID document.

For paranoid verification, sign a test message with the key and verify the signature against the public key. (This is not necessary for routine backup verification; `pds status` is enough.)

## What to do if the key is lost

The recovery options depend on the DID method:

### did:plc with a recovery key

If a recovery key was registered with PLC at account creation, rotate the signing key:

1. Generate a new signing key (`pds secret key`).
2. Use the recovery key to sign a PLC operation that swaps the active signing key.
3. Submit the operation to `plc.directory`.
4. Update Cirrus with the new key (`pds init --production`).

The DID is preserved. Cryptographic continuity holds.

### did:plc without a recovery key

Without a recovery key, the DID is unrecoverable. The only path forward is starting a fresh identity. Followers do not transfer.

### did:web

The domain itself is the recovery mechanism. Cirrus serves the DID document from the Worker at `https://<domain>/.well-known/did.json`, so rotating the key is a configuration change:

1. Generate a new keypair (`pds secret key`).
2. Update `SIGNING_KEY` (a Worker secret) and `SIGNING_KEY_PUBLIC` (a `var` in `wrangler.jsonc`) with the new values.
3. Redeploy. The Worker serves a DID document with the new public key.

See [Manage secrets and rotate keys](/operate/secrets/) for the secret and var commands.

Old commits cannot be verified against the new key, so cryptographic continuity is broken. The account continues; followers continue. Relays accept the new commits.

## What not to do

- **Do not commit `.dev.vars` to git.** The file is in `.gitignore` for a reason.
- **Do not paste the key into a chat, an issue, or a screenshot.** Treat the key as a credential.
- **Do not rely on Cloudflare to recover the key.** Secrets are write-only by design.
- **Do not skip the backup step.** The wizard's prompt is the only time the key is shown.
