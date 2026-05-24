---
title: Implemented endpoints
description: Every XRPC method Cirrus implements directly, grouped by namespace. Unimplemented methods are proxied to the Bluesky AppView.
---

Cirrus implements the XRPC methods required to run a single-user PDS. Methods outside that scope are proxied to the Bluesky AppView using a service JWT signed by the account.

## What "implemented" means

A method appears here if Cirrus serves it directly from its own code. The proxied methods (most `app.bsky.*` reads) reach the same endpoints they would for an account on `bsky.social`; the Worker forwards the request and returns the response.

The status column uses:

- ✅ — implemented and exercised in production.
- 🟡 — implemented as a stub (returns a sensible default but does not do real work).
- ❌ — not implemented locally. The Worker falls through to the auto-proxy and forwards to the AppView, which will usually reject the call. Cirrus does not return 501.

## com.atproto.repo

Repository read/write operations.

| Method | Status | Notes |
|---|---|---|
| `describeRepo` | ✅ | Lists collections and the DID document. |
| `getRecord` | ✅ | Single record by URI. |
| `listRecords` | ✅ | Paginated, cursor support, reverse order. |
| `createRecord` | ✅ | Validates against the loaded lexicon. |
| `putRecord` | ✅ | Same validation. |
| `deleteRecord` | ✅ | |
| `applyWrites` | ✅ | Batch create/put/delete in a single commit. |
| `uploadBlob` | ✅ | 60 MB hard limit. Streams to R2. |
| `importRepo` | ✅ | Accepts a CAR file upload. Used during migration. |
| `listMissingBlobs` | ✅ | Lists blobs referenced by records but not yet uploaded. |

## com.atproto.sync

Federation and replication.

| Method | Status | Notes |
|---|---|---|
| `getRepo` | ✅ | Streams a CAR export. |
| `getRepoStatus` | ✅ | Active state and current revision. |
| `listRepos` | ✅ | Single-user PDS returns only the local account. |
| `getLatestCommit` | ✅ | Latest commit CID and revision. |
| `getBlocks` | ✅ | CAR file with requested blocks. |
| `listBlobs` | ✅ | Paginated, with cursor. |
| `getBlob` | ✅ | Streams directly from R2. |
| `getRecord` | ✅ | Single record by CID. |
| `subscribeRepos` | ✅ | WebSocket firehose. CBOR frames. |

## com.atproto.server

Server-level metadata and session management.

| Method | Status | Notes |
|---|---|---|
| `describeServer` | ✅ | Capabilities, supported auth methods. |
| `createSession` | ✅ | Account password or app password. Issues JWT pair. |
| `refreshSession` | ✅ | Stateless refresh. |
| `getSession` | ✅ | |
| `deleteSession` | ✅ | Stateless (clears refresh on client). |
| `createAppPassword` | ✅ | |
| `listAppPasswords` | ✅ | |
| `revokeAppPassword` | ✅ | |
| `activateAccount` | ✅ | |
| `deactivateAccount` | ✅ | |
| `getAccountStatus` | ✅ | Activation state, metrics. |
| `checkAccountStatus` | ✅ | |
| `getServiceAuth` | ✅ | Issues service JWTs for AppView callbacks. |
| `requestEmailUpdate` | 🟡 | Stub. |
| `updateEmail` | 🟡 | Stub. |
| `requestEmailConfirmation` | 🟡 | Stub. |
| `createAccount` | ❌ | Single-user PDS — account is created by `pds init`. Falls through to the AppView proxy. |
| `deleteAccount` | ❌ | Not needed for single-user PDS. Falls through to the AppView proxy. |

The unimplemented server methods are multi-user/operator features (creating accounts, password reset emails, admin invitations) that are not relevant to a single-user deployment. Cirrus does not return 501 for them — the request is forwarded to the AppView, which will typically reject it.

## com.atproto.identity

Identity resolution.

| Method | Status | Notes |
|---|---|---|
| `resolveHandle` | ✅ | Returns the local DID for the local handle. Other handles fall through to the AppView proxy. |
| `requestPlcOperationSignature` | ✅ | Used by the outbound migration flow. |
| `signPlcOperation` | ✅ | Signs a PLC operation with the account's signing key. |

The CLI (`pds identity`, `pds migrate`) drives outbound migration on top of these endpoints. Other identity methods (`submitPlcOperation`, `updateHandle`, `getRecommendedDidCredentials`) are not registered locally and fall through to the AppView proxy.

## app.bsky

Bluesky AppView surface. Most `app.bsky.*` methods are proxied to `api.bsky.app`. The exceptions are stored locally:

| Method | Status | Notes |
|---|---|---|
| `actor.getPreferences` | ✅ | Stored in the Durable Object. |
| `actor.putPreferences` | ✅ | |
| `ageassurance.getState` | 🟡 | Returns `assured`. Stub. |

Everything else under `app.bsky.*` (feeds, profiles, notifications, search) is proxied. The proxy attaches a service JWT signed by the account key.

## Auto-proxy behaviour

For any XRPC method not in the lists above, Cirrus:

1. Mints a service JWT with the account DID as the issuer, `did:web:api.bsky.app` as the audience, and the called method's NSID as the `lxm` claim.
2. Forwards the request to `https://api.bsky.app` with `Authorization: Bearer <service-jwt>`.
3. Returns the AppView's response unmodified.

This is what makes the Bluesky app work end-to-end against a Cirrus PDS without Cirrus needing to implement social-graph queries.

## OAuth surface

OAuth endpoints are not XRPC methods; they live under `/oauth/*` and `/.well-known/oauth-authorization-server`. See [OAuth 2.1 surface](/reference/oauth/).
