---
title: Authentication methods
description: The five auth methods Cirrus accepts, what each is for, and which to pick.
---

Cirrus accepts five distinct authentication methods. Each fits a different caller: the account owner, the Bluesky app, third-party clients, OAuth applications, and services calling back.

This page covers what each method is, when it applies, and what configuration it needs. For per-method setup, see the linked guides.

## At a glance

| Method | Used by | Lifetime | Setup needed |
|---|---|---|---|
| **Static bearer token** | Account owner for admin operations | Indefinite | `AUTH_TOKEN` secret |
| **Session JWT** | Bluesky app login | 120 min access, 90 day refresh | `JWT_SECRET`, `PASSWORD_HASH` |
| **App password** | Third-party AT Protocol clients | Indefinite (revocable) | Created with `pds app-password create` |
| **OAuth 2.1 + DPoP** | Modern OAuth clients with granular scopes | 1 hour access, refresh-rotated | Bundled — no extra setup |
| **Passkey (WebAuthn)** | Passwordless OAuth sign-in | Per-credential | Registered with `pds passkey add` |
| **Service JWT** | Outbound calls to other AT Protocol services | 5 min | Signed by the account key automatically |

## Static bearer token

The `AUTH_TOKEN` env var is a long-lived secret that grants full admin access. It is the simplest auth method and is intended for the account owner.

Use it when:
- Running admin operations from the CLI.
- Bootstrapping the account before other auth is set up.
- Driving the PDS from a personal script.

Avoid it for:
- Anything that needs scope-limited access.
- Anything that needs to be revoked individually (app passwords are better).

Send it as `Authorization: Bearer <token>`.

## Session JWT

Session JWTs are how the Bluesky app signs in. They are issued by `com.atproto.server.createSession` after `createSession` verifies the supplied credential. An account password is checked against the `PASSWORD_HASH` env var (bcrypt). An app password is checked against the bcrypt hash stored for that specific app password in the Durable Object.

The flow:

1. Client posts username + password to `createSession`.
2. Cirrus verifies the password and returns an access JWT (120 min) and a refresh JWT (90 days).
3. Client sends the access JWT as `Authorization: Bearer <jwt>` on every request.
4. Before the access JWT expires, the client calls `refreshSession` to get a new pair.

Cirrus signs session JWTs with HMAC-SHA256 using the `JWT_SECRET`. The subject is the account DID.

Use sessions when:
- The Bluesky app is the client.
- A first-party client uses interactive login.

## App passwords

App passwords look like `xxxx-xxxx-xxxx-xxxx`. They behave like the account password as far as `createSession` is concerned, but each is named, individually revocable, and bcrypt-stored.

The flow:

1. Run `pds app-password create` to mint one. The CLI prints the password once.
2. Give the password to the third-party client.
3. The client signs in via `createSession` exactly as it would with the account password.
4. To revoke, run `pds app-password revoke`.

Use app passwords when:
- A third-party AT Protocol client (a feed builder, a poster app, a bot) needs to write to the account.
- Per-app revocation matters.

See [Create an app password](/guides/app-password/).

## OAuth 2.1 with DPoP

Cirrus bundles an OAuth 2.1 provider (`@getcirrus/oauth-provider`). It exposes the standard endpoints:

- `/.well-known/oauth-authorization-server` — server metadata.
- `/oauth/par` — pushed authorisation requests.
- `/oauth/authorize` — authorisation page (supports password and passkey).
- `/oauth/token` — token issuance.
- `/oauth/revoke` — token revocation.

OAuth tokens are **DPoP-bound**: every request must include a `DPoP` proof header signed by the client's key pair. Stealing the access token alone is not enough to impersonate the client.

OAuth tokens carry **granular scopes** (for example `repo:app.bsky.feed.post`). Cirrus enforces scope on each XRPC endpoint.

Use OAuth when:
- A third-party application uses the modern AT Protocol OAuth flow.
- Scope limitation matters (a posting client should not be able to delete the account).

OAuth is enabled automatically as part of the PDS deployment. No extra configuration.

## Passkeys (WebAuthn)

Passkeys replace passwords on the OAuth authorisation page. A registered passkey signs an OAuth challenge instead of requiring a typed password.

The flow:

1. Run `pds passkey add` to start registration. The CLI prints a one-time URL valid for ten minutes.
2. Open the URL on a device with a passkey-capable authenticator (Touch ID, Face ID, hardware key).
3. Register the credential.
4. From then on, OAuth sign-ins offer the passkey as an option.

Use passkeys when:
- The OAuth flow is in use and password entry is unwanted.
- Phishing resistance is the goal.

See [Set up passkey login](/guides/passkey-login/).

## Service JWTs

Service JWTs are short-lived tokens (5 minutes) that the PDS mints on demand to assert the account's identity to other AT Protocol services — for example, when the Bluesky AppView calls back to the PDS, or when the PDS proxies a request to the AppView.

The PDS signs service JWTs with the account's signing key (`SIGNING_KEY`). They are not used directly by end-user clients. Service JWTs are created automatically; no configuration needed.

## Which to use

- **Bluesky app sign-in:** session JWT, via `createSession` with the account password (or an app password).
- **Third-party AT Protocol client:** app password if it supports legacy sessions, OAuth if it supports the new flow.
- **Admin scripts run locally:** static bearer token (`AUTH_TOKEN`).
- **Phishing-resistant sign-in:** passkey, behind the OAuth flow.
- **Service calling back to the PDS:** service JWT (handled automatically).
