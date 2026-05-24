---
title: Set up passkey login
description: Register a passkey for passwordless sign-in through the Cirrus OAuth flow.
---

A passkey replaces a typed password with a device-held credential. Cirrus supports passkeys on its OAuth 2.1 authorisation page: any OAuth flow can sign in with a registered passkey instead of the account password.

## What a passkey gives

- **No typing.** Authentication uses the device's biometric (Touch ID, Face ID) or a hardware key.
- **Phishing resistance.** A passkey is bound to the origin and cannot be replayed against a lookalike site.
- **Per-device credentials.** Each device gets its own passkey. Losing a device means revoking one credential, not resetting the account.

Passkeys do not replace the account password for the Bluesky app's `createSession` flow. They are specifically for OAuth-based sign-in. The Bluesky app uses `createSession`; OAuth-based AT Protocol clients use the OAuth flow.

## Register a passkey

From the Cirrus project directory:

```bash
pnpm pds passkey add
```

The CLI prints a one-time URL (and a QR code). The URL is valid for ten minutes.

1. Open the URL on a device with a passkey-capable authenticator.
2. The page prompts to create a credential (Touch ID, Face ID, security key, or platform passkey manager).
3. Confirm the prompt.
4. The CLI returns success and the new passkey appears in `pds passkey list`.

Name the passkey when prompted, so it can be identified later in `list`.

## Sign in with the passkey

The passkey is used during OAuth authorisation:

1. A third-party client redirects to `https://pds.example.com/oauth/authorize?...`.
2. The Cirrus authorisation page offers **Sign in with passkey**.
3. The browser prompts for the device's authenticator.
4. On success, the OAuth flow completes and returns the access and refresh tokens to the client.

The full flow is the same as any OAuth 2.1 + DPoP login. The passkey just replaces the password step.

## Manage registered passkeys

List all registered passkeys with their last-used timestamps:

```bash
pnpm pds passkey list
```

Remove a passkey (for example, after losing the device):

```bash
pnpm pds passkey remove
```

The command prompts to select a passkey from the list.

## Recovery if all passkeys are lost

If every passkey is unusable (device lost, all credentials wiped), the account password still works. Sign in with the password and re-register a fresh passkey.

If the account password is also unknown, set a new one:

```bash
pnpm pds secret password
```

This prompts for a new password, bcrypts it, and pushes the hash to Cloudflare as the `PASSWORD_HASH` secret via `wrangler secret put`. The Worker picks up the new secret on its next invocation. From there, sign in normally and re-register passkeys.

## What passkeys do not do

- They do not replace the signing key. The signing key is the cryptographic root of the account; passkeys are an auth method for the OAuth flow.
- They do not sync across devices automatically unless the platform passkey provider syncs them (iCloud Keychain, Google Password Manager, 1Password). Each new device needs registration.
- They do not work outside the OAuth flow. `createSession` (the Bluesky app's sign-in path) does not use passkeys.
