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

The app logs-in to your Cirrus PDS. On success, it loads the timeline.

## How the app talks to Cirrus afterwards

Once signed in, the Bluesky app will use your Cirrus PDS for all API calls. This is transparent to the user: the app's UI and features work the same as with `bsky.social`. The only difference is that behind the scenes, the app talks to your Cirrus PDS instead of `bsky.social`'s PDS.

## Using an app password instead

To avoid putting the main account password into the app, create an app password and sign in with that:

```bash
pnpm pds app-password create
```

The CLI prints the password once (format `xxxx-xxxx-xxxx-xxxx`). Use it on the sign-in screen in place of the account password. See [Create an app password](/guides/app-password/) for the full flow.

## Trouble signing in

**"Could not connect to PDS"** — verify the PDS hostname. `https://pds.example.com/xrpc/com.atproto.server.describeServer` should return JSON.

**"Invalid handle or password"** — make sure you're loggin-in with your handle, not your email address. Verify that the handle resolves to the expected DID (`pds status`) and that the password matches the bcrypt hash in `PASSWORD_HASH`. If the password was lost, set a new one with `pds secret password` (it pushes a new hash to Cloudflare).

**The app signs in but the timeline is empty** — the account is brand new and follows nobody. Follow accounts to populate the timeline.

For more, see [Troubleshoot common errors](/guides/troubleshoot/).
