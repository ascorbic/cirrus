---
title: First login
description: Confirm the deployed PDS works end to end by resolving the handle and signing in from the Bluesky app.
---

After the [Quick start](/start/quick-start/), the PDS is live but unused. This page verifies that the deployment is reachable, the handle resolves correctly, and the account can sign in.

## Resolve the handle

Handle resolution is the step that connects a human-readable name to a DID. Test it directly:

```bash
pnpm pds status
```

The status command prints the handle, the DID, the resolved DID document, the repository revision, and the blob count. A green check next to **Handle resolves** confirms that the network can find the account from the handle.

For a manual check, query the resolver endpoint:

```bash
curl "https://pds.example.com/xrpc/com.atproto.identity.resolveHandle?handle=alice.example.com"
```

The response is `{"did": "did:..."}`.

If resolution fails, see [Troubleshoot common errors](/guides/troubleshoot/#handle-does-not-resolve).

## Sign in from the Bluesky app

The Bluesky mobile and web apps support custom PDS hosts via the **Hosting provider** setting.

1. Open the Bluesky app (mobile or [bsky.app](https://bsky.app)).
2. Choose **Sign in**.
3. Tap or click **Hosting provider** and choose **Custom**.
4. Enter the PDS hostname (for example `pds.example.com`).
5. Enter the handle and the account password set during the wizard.

Once signed in, the app fetches the repository, refreshes the feed, and the account is live.

## What happens behind the scenes

The Bluesky app calls `com.atproto.server.createSession` against the custom PDS. Cirrus verifies the password against the bcrypt hash in `PASSWORD_HASH` and returns a session JWT pair (access and refresh). The app then talks to the PDS for write operations and to the Bluesky AppView (`api.bsky.app`) for reads — the PDS proxies unknown XRPC methods to the AppView automatically. See [Authentication methods](/concepts/auth/) for the full picture.

## Optional: register a passkey for OAuth sign-ins

Passkeys in Cirrus are for the OAuth authorization flow. They let OAuth clients (and the Cirrus OAuth authorize page) sign in without typing the account password. They do **not** replace the password for the Bluesky app: that app uses `createSession`, which is password-based.

```bash
pnpm pds passkey add
```

The command prints a URL (and QR code) that opens a registration page valid for ten minutes. Follow [Set up passkey login](/guides/passkey-login/) for the full flow.

## Optional: create an app password for third-party clients

App passwords let third-party AT Protocol clients sign in without exposing the main account password:

```bash
pnpm pds app-password create
```

See [Create an app password](/guides/app-password/) for details.

## Next

The PDS now serves a live Bluesky account. From here:

- Read [How Cirrus is built](/concepts/architecture/) to understand what the deployment is doing.
- Read [Monitor your PDS](/operate/monitor/) to keep an eye on it.
- If running multiple accounts (one per Cloudflare Worker), repeat the install for each.
