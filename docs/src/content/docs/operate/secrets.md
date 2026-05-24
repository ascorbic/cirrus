---
title: Manage secrets and rotate keys
description: Cloudflare Worker secrets, how to rotate them safely, and what each secret controls.
---

Cirrus stores four Worker secrets, each with a different lifetime and rotation profile:

| Secret | Controls | Rotation cost |
|---|---|---|
| `SIGNING_KEY` | Repository signatures, service JWTs | High — changes the DID document |
| `JWT_SECRET` | Session JWT signing (120 min access tokens, 90 day refresh tokens) | Low — invalidates active sessions |
| `PASSWORD_HASH` | Account password verification | Low — forces a sign-in next time |
| `AUTH_TOKEN` | Static bearer token for admin | Low — invalidates current scripts |

The signing key has a sibling public value, `SIGNING_KEY_PUBLIC`, that lives in `wrangler.jsonc` as a `var` (not a secret). It is the public half of the signing keypair and is used to serve the DID document. Rotating the signing key requires updating both.

This page covers how to rotate each.

## Where secrets live

In local development, secrets are in `.dev.vars` (gitignored).

In production, secrets are Worker secrets stored on Cloudflare. They are write-only: once set, the dashboard and API do not return their value. Push secrets from `.dev.vars` to production with:

```bash
pnpm pds init --production
```

This runs the wizard in production mode: it reads each secret from `.dev.vars` and uploads it as a Worker secret.

For a single secret, use `wrangler` directly:

```bash
pnpm wrangler secret put SIGNING_KEY
```

The command prompts for the value (it is not visible in shell history).

## Rotate the JWT secret

Rotating `JWT_SECRET` invalidates all existing session JWTs. Users must sign in again.

```bash
pnpm pds secret jwt
```

The `pds secret jwt` command generates a fresh secret and uploads it to Cloudflare as the `JWT_SECRET` Worker secret via `wrangler secret put`.

To write the new secret to `.dev.vars` instead of uploading it, pass `--local`:

```bash
pnpm pds secret jwt --local
```

After rotation, the next Bluesky app sign-in re-issues a session signed with the new secret. Existing sessions silently stop working.

## Rotate the account password

Rotating the password invalidates the previous password. App passwords are unaffected (they are stored independently).

```bash
pnpm pds secret password
```

The `pds secret password` command prompts for the new password (or generates one), bcrypts it, and uploads the hash to Cloudflare as the `PASSWORD_HASH` Worker secret.

Pass `--local` to write the hash to `.dev.vars` instead:

```bash
pnpm pds secret password --local
```

After rotation, sign in with the new password.

## Rotate the static auth token

`AUTH_TOKEN` is the long-lived admin bearer. Rotate by generating a new random value and uploading it:

```bash
# Generate a fresh token (any method works; e.g.):
openssl rand -hex 32

pnpm wrangler secret put AUTH_TOKEN
```

Update any scripts that use the previous token.

## Rotate the signing key

Rotating `SIGNING_KEY` is the most consequential operation. The signing key is referenced by the DID document; rotation requires publishing an updated DID document.

`pds secret key` generates a new secp256k1 keypair and updates both halves in one step:

- The private half is uploaded to Cloudflare as the `SIGNING_KEY` Worker secret.
- The public half is written to the `SIGNING_KEY_PUBLIC` `var` in `wrangler.jsonc`.

`SIGNING_KEY_PUBLIC` is a public configuration value, not a secret. It must be edited in `wrangler.jsonc` (or via `pds secret key`) and picked up by the next `wrangler deploy`. Running `wrangler secret put SIGNING_KEY_PUBLIC` is wrong — it will not affect the served DID document.

### For did:plc with a recovery key

The PLC operation handles the rotation:

1. Generate a new signing key. This uploads `SIGNING_KEY` and updates `SIGNING_KEY_PUBLIC` in `wrangler.jsonc`:
   ```bash
   pnpm pds secret key
   ```
2. Sign a PLC operation with the recovery key that swaps the active signing key to the new one. The Bluesky app's settings or the [PLC tooling](https://github.com/did-method-plc/did-method-plc) can do this. The new public key is now in `wrangler.jsonc`; use it in the operation.
3. Submit the operation to `plc.directory`.
4. Redeploy so the Worker picks up the new `SIGNING_KEY_PUBLIC` value:
   ```bash
   pnpm run deploy
   ```

The DID is preserved. Existing signed commits remain verifiable against the previous public key, which is still recorded in the DID document's history.

### For did:web

For `did:web`, the DID document is served by Cirrus itself. Rotation is simpler but breaks cryptographic continuity:

1. Generate a new signing key. This uploads `SIGNING_KEY` and updates `SIGNING_KEY_PUBLIC` in `wrangler.jsonc`:
   ```bash
   pnpm pds secret key
   ```
2. Redeploy:
   ```bash
   pnpm run deploy
   ```

The served DID document now lists the new public key. Old signed commits do not verify against the new key. Followers and content survive — relays accept new commits because the DID document advertises the new key — but the cryptographic chain is reset.

## When to rotate

- **`SIGNING_KEY`**: on suspected compromise, periodically (annually is reasonable hygiene), and after a recovery scenario.
- **`JWT_SECRET`**: on suspected compromise. Otherwise rarely.
- **`PASSWORD_HASH`**: on suspected compromise, or when the password is reused elsewhere.
- **`AUTH_TOKEN`**: when an admin script holding it is decommissioned or when collaborators with access change.

## Back up the new secrets

Every rotation produces a new secret value. Update the backup (password manager, encrypted file) at the same time the production secret is rotated. See [Back up your signing key](/guides/back-up-signing-key/) — the same advice applies to all four secrets, with the signing key being the highest-stakes one.
