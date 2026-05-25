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

For a manual check, open the resolver endpoint:

```bash
https://pds.example.com/xrpc/com.atproto.identity.resolveHandle?handle=alice.example.com
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

## Optional: register a passkey for OAuth sign-ins

Passkeys in Cirrus are for the OAuth authorization flow. They are a secure way to login to other Atmosphere apps such as Leaflet or Tangled, without sharing your account password. They do **not** replace the password for the Bluesky app:

```bash
pnpm pds passkey add
```

The command prints a URL (and QR code) that opens a registration page valid for ten minutes. Follow [Set up passkey login](/guides/passkey-login/) for the full flow.

## Next

The PDS now serves a live Bluesky account. From here:

- Read [How Cirrus is built](/concepts/architecture/) to understand what the deployment is doing.
- Read [Monitor your PDS](/operate/monitor/) to keep an eye on it.
- If running multiple accounts (one per Cloudflare Worker), repeat the install for each.
