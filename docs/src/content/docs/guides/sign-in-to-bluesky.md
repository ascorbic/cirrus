---
title: Sign in to Bluesky
description: Use the Bluesky app with a Cirrus-hosted account by selecting the custom PDS hostname.
---

The Bluesky app (mobile and web) supports custom PDS hosts. The hosting provider option on the sign-in screen accepts any PDS hostname.

## Sign-in flow

1. Open the Bluesky app or [bsky.app](https://bsky.app).
2. Choose **Sign in**.
3. Tap or click **Hosting provider** and choose **Custom**.
4. Enter the PDS hostname, for example `pds.example.com`.
5. Enter the handle (for example `alice.example.com`) and the account password set during `pds init`.

The app calls `com.atproto.server.createSession` on the custom PDS. On success, it loads the timeline.

## How the app talks to Cirrus afterwards

Once signed in, the app sends write operations to Cirrus and reads to the Bluesky AppView (`api.bsky.app`).

Cirrus proxies any XRPC method it does not implement directly to the AppView, attaching a service JWT signed by the account. This is what makes feeds, notifications, search, and profile views work without Cirrus implementing each endpoint.

The user does not see a difference between a Cirrus-hosted account and a `bsky.social`-hosted account in the app.

## Using an app password instead

To avoid putting the main account password into the app, create an app password and sign in with that:

```bash
pnpm pds app-password create
```

The CLI prints the password once (format `xxxx-xxxx-xxxx-xxxx`). Use it on the sign-in screen in place of the account password. See [Create an app password](/guides/app-password/) for the full flow.

## Trouble signing in

**"Could not connect to PDS"** — verify the PDS hostname. `curl https://pds.example.com/xrpc/com.atproto.server.describeServer` should return JSON.

**"Invalid handle or password"** — verify that the handle resolves to the expected DID (`pds status`) and that the password matches the bcrypt hash in `PASSWORD_HASH`. If the password was lost, set a new one with `pds secret password` (it pushes a new hash to Cloudflare).

**The app signs in but the timeline is empty** — the account is brand new and follows nobody. Follow accounts to populate the timeline.

For more, see [Troubleshoot common errors](/guides/troubleshoot/).
