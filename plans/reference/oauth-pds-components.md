# OAuth for PDS: Major Components

How AT Protocol OAuth 2.1 works for apps to read/write a user's repo.

## 1. OAuth Authorization Server (AS)

The PDS itself acts as the AS. It must:
- Serve metadata at `/.well-known/oauth-authorization-server` (endpoints, supported grants, DPoP requirements, scopes)
- Implement **PAR** (Pushed Authorization Requests) — AT Protocol requires this; the client POSTs the auth request first, gets back a `request_uri`, then redirects the user
- Provide an **authorization endpoint** — a UI where the user reviews and approves the app's requested scopes
- Provide a **token endpoint** — issues DPoP-bound access tokens and refresh tokens
- Handle **client discovery** — fetch and validate the app's client metadata from its published URL

## 2. OAuth Client (the App)

The third-party app that wants repo access. It must:
- Publish **client metadata** at a well-known URL (redirect URIs, grant types, scopes, name, logo)
- Generate a **DPoP keypair** — AT Protocol OAuth requires Demonstration of Proof-of-Possession, not plain bearer tokens
- Handle the redirect flow (PAR → redirect → callback → token exchange)
- Include a DPoP proof on every API request

## 3. Resource Server (RS)

Also the PDS — the XRPC endpoints that actually read/write the repo. It must:
- Validate **DPoP-bound access tokens** on each request (verify the DPoP proof matches the token's binding)
- Enforce **scopes** — check that the token authorizes the specific operation (e.g., `atproto` transition scope, or finer-grained collection scopes)
- Identify the user (DID) from the token

## 4. DPoP (Proof of Possession)

This is what makes AT Protocol OAuth different from typical OAuth. Instead of bearer tokens (anyone with the token can use it), each access token is bound to a client keypair:
- Client sends a signed DPoP proof header with every request
- Server checks the proof's signature matches the key thumbprint bound to the token
- A stolen token is useless without the client's private key

## 5. Authorization / Consent UI

A web page hosted by the PDS where the user:
- Sees which app is requesting access
- Reviews requested scopes
- Approves or denies
- Gets redirected back to the app with an authorization code

## 6. Token Storage

The AS needs persistent storage for:
- Authorization codes (short-lived, single-use)
- Access tokens (or their metadata — DPoP binding, scopes, expiry)
- Refresh tokens (long-lived, for token rotation)
- Client registrations / sessions

## Why OAuth Is Heavy for Service-to-Service

All of this machinery exists to protect **end users in a browser**. For a background service (like a cast importer) that just wants to write posts, OAuth requires:

- A browser redirect (the user must visit the AS in a browser)
- PAR + authorization code exchange
- DPoP keypair management
- Token refresh lifecycle

The service keys plan (`plans/todo/service-keys.md`) shortcuts all of this: the service has a DID, the user registers its public key, the service signs requests directly. No browser, no redirect, no token lifecycle.

## OAuth vs Service Keys

| | OAuth 2.1 | Service Keys |
|---|---|---|
| **For** | End-user apps (Bluesky clients, third-party UIs) | Background services, bots, importers |
| **Auth flow** | Browser redirect | No browser needed |
| **Token type** | DPoP-bound access token | Signed HTTP request or JWT |
| **Complexity** | High (AS, PAR, DPoP, consent UI, token storage) | Low (public key registration, signature verification) |
| **Ecosystem compat** | Standard — any AT Protocol OAuth client works | Custom — services must implement your specific scheme |

They serve different audiences and are complementary, not competing.
