---
title: OAuth 2.1 surface
description: The OAuth endpoints Cirrus exposes, the supported features, and the wire-level details.
---

Cirrus bundles a full OAuth 2.1 provider (`@getcirrus/oauth-provider`) inside the PDS Worker. The provider handles authorisation, token issuance, revocation, and discovery. There is no separate service.

This page documents the wire surface. For the higher-level pick-an-auth-method overview, see [Authentication methods](/concepts/auth/).

## Discovery

```
GET /.well-known/oauth-authorization-server
```

Returns the standard [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) metadata describing the provider: issuer, supported response types, supported scopes, token endpoint, PAR endpoint, DPoP signing algorithms.

Clients use this to bootstrap. The discovery response is the source of truth for endpoint URLs.

## Endpoints

### POST /oauth/par

Pushed Authorization Request. The client posts the full authorisation request server-side and receives a `request_uri` to use at `/oauth/authorize`. This keeps client secrets and code challenges off the user-facing URL.

PAR is **required** by the provider; conventional `?response_type=code` URLs are rejected.

### GET /oauth/authorize

Authorisation endpoint. Takes a `request_uri` returned from `/oauth/par`. Renders the consent page:

- Shows the client's metadata (name, redirect URI).
- Offers password sign-in.
- Offers passkey sign-in if any passkey is registered.

On success, redirects to the client's `redirect_uri` with the authorisation code.

### POST /oauth/token

Token endpoint. Exchanges the authorisation code (with PKCE verifier) for an access token and refresh token. Requires a DPoP proof header.

Returns:

- `access_token` — opaque, DPoP-bound, scope-limited. TTL: 1 hour.
- `refresh_token` — opaque, DPoP-bound, longer-lived. TTL: 90 days.
- `token_type: DPoP`.
- `expires_in`.
- `scope`.

The same endpoint refreshes tokens with `grant_type=refresh_token`.

### POST /oauth/passkey-auth

Completes a passkey (WebAuthn) sign-in initiated from `/oauth/authorize`. The consent page posts the assertion here.

### GET /oauth/userinfo

OpenID Connect userinfo endpoint. Requires a valid access token (with a matching DPoP proof when the token is DPoP-bound). Returns `{ sub, preferred_username }` for the authenticated user.

### POST /oauth/revoke

Revokes a token (access or refresh). Returns 200 on success per the spec.

## DPoP

[Demonstrating Proof of Possession](https://datatracker.ietf.org/doc/html/rfc9449) binds tokens to a client-held key pair. Every authenticated request includes a `DPoP` header with a JWT signed by the client's private key.

Access tokens are opaque random strings, not JWTs. The DPoP binding lives server-side: when the token is issued, Cirrus stores the JWK thumbprint (`jkt`) of the client's DPoP key alongside the token.

On each authenticated request, Cirrus validates:

- The DPoP JWT signature against the public key embedded in the proof's header.
- The JWK thumbprint of the proof matches the `jkt` recorded for the access token.
- The `htm` and `htu` claims match the request method and URL.
- The `ath` claim matches the SHA-256 of the access token.
- The `iat` is fresh.
- The `jti` has not been replayed.

A stolen access token alone is not usable without the corresponding private key.

The supported DPoP signing algorithms are listed in the discovery metadata. Cirrus accepts ES256.

## Scopes

OAuth tokens carry granular scopes. Cirrus checks the scope of the access token against the called endpoint.

Every token carries the base `atproto` scope. On top of that, the grammar supports:

- **Granular permissions** for the five resource types: `repo:`, `rpc:`, `blob:`, `account:`, `identity:`. Each takes structured arguments (for example `repo:app.bsky.feed.post?action=create` or `rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app`).
- **Legacy transition scopes** for back-compat with pre-granular clients: `transition:generic` covers everything except `account:` permissions, `transition:email` adds `account:email`, `transition:chat.bsky` adds RPC access for `chat.bsky.*`.
- **Permission-set includes** of the form `include:<nsid>?aud=<did>`. Cirrus resolves these at authorize-time via the client's published permission set and expands them inline into concrete granular scopes before the auth code is stored, so resource-server checks never need network access.

The metadata advertises the supported scope tokens (`atproto`, the five granular resources, the three transition scopes, and `include` when a permission-set resolver is configured).

For the canonical reference, see the [AT Protocol OAuth specification](https://atproto.com/specs/oauth).

## PKCE

[Proof Key for Code Exchange](https://datatracker.ietf.org/doc/html/rfc7636) is required. The client generates a `code_verifier`, sends its hash as `code_challenge` in PAR, and proves possession at the token endpoint.

The supported challenge method is `S256`.

## Client metadata

Cirrus discovers client metadata from the client's `client_id` URL. The client publishes a JSON document describing itself (name, redirect URIs, supported scopes). This eliminates the registration step in conventional OAuth.

The `client_id` is the URL of the metadata document, for example `https://my-client.example.com/client-metadata.json`.

## Storage

OAuth state (authorisation codes, access tokens, refresh tokens, PAR requests, DPoP nonces, client metadata cache) lives in the Durable Object's SQLite. There is no external dependency.

Cleanup of expired records happens lazily on access. Long-idle PDSes do not accumulate cruft because nothing is queried.

## Usage from a client

A typical client flow:

1. Fetch `https://pds.example.com/.well-known/oauth-authorization-server`.
2. Generate a key pair (for DPoP).
3. Push the authorisation request to `/oauth/par`.
4. Redirect the user to `/oauth/authorize?request_uri=...`.
5. On callback, exchange the code at `/oauth/token` with a DPoP proof.
6. Use the access token (with a DPoP proof on each request) against any Cirrus XRPC endpoint.

For a reference implementation in TypeScript, see the [atproto OAuth client library](https://github.com/bluesky-social/atproto/tree/main/packages/oauth/oauth-client).

## What is not supported

- **Implicit flow.** Not part of OAuth 2.1.
- **Resource owner password credentials grant.** Not part of OAuth 2.1.
- **Client secrets.** Replaced by DPoP + client metadata discovery.
- **Token introspection endpoint.** Cirrus does not expose `/oauth/introspect`.
