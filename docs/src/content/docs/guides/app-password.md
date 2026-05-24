---
title: Create an app password
description: Mint a named, revocable password for a third-party AT Protocol client.
---

An app password is a named, individually revocable credential that behaves like the account password for `createSession`. Use one per third-party client.

## Why use them

Giving the account password directly to a third-party client has two problems: the client sees the same password used everywhere, and revoking it means changing the password and updating every other client.

App passwords avoid both. Each one is named (`my-feed-builder`, `mobile-poster-bot`), can be revoked individually, and never shows the account password to the client.

## Create one

```bash
pnpm pds app-password create
```

The CLI prompts for a name, then prints the password once in the format `xxxx-xxxx-xxxx-xxxx`. **Save it then; it is not shown again.**

Give the password (along with the account handle) to the third-party client. The client signs in with `com.atproto.server.createSession` using the handle and the app password exactly as it would with the account password.

## List existing app passwords

```bash
pnpm pds app-password list
```

This shows the names of all created app passwords. It does not show the passwords themselves — those are only printed at creation time.

## Revoke an app password

```bash
pnpm pds app-password revoke
```

The command prompts to select a password from the list and confirms before revoking. Pass `-y` to skip the confirmation.

Revocation removes the password's hash from the Durable Object, so no new sessions can be created with it. Session JWTs are stateless: existing access tokens remain valid until they expire (120 minutes), and refresh tokens can still be exchanged for new access tokens until they expire (90 days). To invalidate every active session immediately, rotate `JWT_SECRET` — see [Manage secrets and rotate keys](/operate/secrets/).

## When to prefer OAuth instead

App passwords are a legacy mechanism. They predate the AT Protocol OAuth flow and they grant full access — the password can do anything the account can do.

For clients that support OAuth 2.1 with DPoP, prefer OAuth. OAuth tokens carry granular scopes (`repo:app.bsky.feed.post`, `repo:app.bsky.graph.follow`) and are DPoP-bound, so stealing the token alone is not enough. See [Authentication methods](/concepts/auth/).

Use app passwords when:

- The client only supports legacy session-based auth.
- A scriptable, copy-paste credential is the simplest fit.
- Full account access is acceptable and revocation alone is enough isolation.

## What app passwords cannot do

- They cannot be reset or recovered. Lost passwords stay lost — create a new one.
- They cannot be scoped. Any holder can do anything the account can do.
- They do not work with the OAuth flow. They are only valid through `createSession`.
