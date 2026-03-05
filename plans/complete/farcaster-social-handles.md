# Farcaster Name Handles (`FNAME.farcaster.social`)

## Status: Complete

## Overview

WebFID accounts can now use their Farcaster name as their AT Protocol handle via `FNAME.farcaster.social` (e.g., `boscolo.farcaster.social`), in addition to the default `NNN.fid.is`.

AT Protocol resolves handles via `https://HANDLE/.well-known/atproto-did` returning the DID as plain text. A separate Cloudflare Worker on `*.farcaster.social` handles this resolution by looking up `FNAME → FID → DID` via the Farcaster FNAME registry.

## Architecture

### Key Design Principle: PDS is a Dumb Store

The PDS stores whatever handle it's given without validation. FNAME ownership verification happens entirely in the miniapp before sending to the PDS. This is correct because:

- AT Protocol clients verify handles via forward lookup (`/.well-known/atproto-did`), not by trusting the PDS
- The PDS just needs `alsoKnownAs` in the DID document to match what the handle resolution endpoint returns
- Setting an empty string as a handle is legal

### Components

**1. Handle Resolution Worker (`apps/fname-to-handle/`)**

Cloudflare Worker deployed on `*.farcaster.social` with wildcard DNS (A record `192.0.2.1`, proxied).

- Serves `GET /.well-known/atproto-did` only, 404 for everything else
- Extracts FNAME from subdomain, looks up FID from `fnames.farcaster.xyz/transfers/current?name=FNAME`
- Returns `did:web:FID.fid.is` as `text/plain` with `Cache-Control: public, max-age=300`
- CORS enabled (`Access-Control-Allow-Origin: *`) for browser-based tools like pdsls.dev

**2. PDS Handle Storage**

- `storage.updateHandle(handle)` — updates `atproto_identity.handle` column
- `accountDO.rpcUpdateHandle(handle)` — RPC wrapper
- DID document (`/.well-known/did.json`) reads handle from `rpcGetAtprotoIdentity()` for `alsoKnownAs`
- `/.well-known/atproto-did` checks account existence, returns 404 for unregistered FIDs
- Session endpoints (`createSession`, `refreshSession`, `getSession`) return stored handle directly

**3. Settings Endpoints**

- `GET /xrpc/is.fid.settings.getHandle` — returns `{ handle }` from stored identity
- `POST /xrpc/is.fid.settings.setHandle` — stores `body.handle` (any string, including empty), emits `#identity` firehose event

**4. Account Creation**

- `createAccount` and `createAccountSiwf` accept optional `handle` in request body
- Defaults to `fidToHandle(fid, domain)` (`NNN.fid.is`) when not provided
- Existing account paths return stored handle as-is, no fallback computation

**5. Miniapp UI**

- `ConfirmCreateScreen` — radio buttons to choose between `FNAME.farcaster.social` and `NNN.fid.is`; verifies FNAME ownership client-side before allowing creation
- `HandleSection` — settings component to switch handle after creation; verifies FNAME ownership via `verifyFnameOwnership()` before calling `setHandle` API

**6. `resolveHandle` — No PDS Changes**

When a client asks the PDS to resolve `FNAME.farcaster.social`, the request falls through to the AppView proxy, which resolves via the `fname-to-handle` Worker.

## Files Modified

| File | Change |
|------|--------|
| `apps/fname-to-handle/` | New Worker (4 files) for `*.farcaster.social` handle resolution |
| `packages/pds/src/storage.ts` | `updateHandle()` method |
| `packages/pds/src/account-do.ts` | `rpcUpdateHandle()` RPC method |
| `packages/pds/src/index.ts` | DID doc uses stored handle; `/.well-known/atproto-did` checks account existence; routes for getHandle/setHandle |
| `packages/pds/src/xrpc/server.ts` | Session endpoints return stored handle |
| `packages/pds/src/xrpc/fid-account.ts` | Accept optional handle in create endpoints |
| `packages/pds/src/xrpc/fid-settings.ts` | `getHandle` / `setHandle` endpoint handlers |
| `apps/miniapp/src/api.ts` | `getHandle`, `setHandle`, `verifyFnameOwnership`; `pdsBaseFromDid()` replacing `pdsBaseFromHandle()` |
| `apps/miniapp/src/App.tsx` | `ConfirmCreateScreen`, `HandleSection` components; `pdsHostnameFromDid()`, `pdsBaseFromDid()` |
| `apps/miniapp/src/index.css` | `.handle-options` / `.handle-option` styles |

## What Does NOT Change

- **DID format**: Still `did:web:NNN.fid.is`
- **DID document location**: Still served at `https://NNN.fid.is/.well-known/did.json`
- **PDS hostname**: Still `pds-NNN.fid.is`
- **DO routing**: Same DID-based routing

## Design Decisions

1. **PDS does not validate handles** — FNAME ownership verification is client-side only. AT Protocol handle verification is done by clients via forward lookup, not by trusting what the PDS stores.
2. **DNS for `*.farcaster.social`**: Wildcard A record (`192.0.2.1`, proxied) routes all subdomains to the `fname-to-handle` Worker.
3. **FNAME transfer handling**: Let it break naturally. The Worker does live FNAME registry lookups, so transferred FNAMEs stop resolving for the old owner. Users can switch back to `NNN.fid.is` via settings.
4. **No concept of "custom" handles in PDS** — the PDS just stores a handle string. The miniapp computes whether a switch is available by comparing stored handle against the user's FNAME and default FID handle.
5. **Miniapp uses DID-based PDS routing** — `pdsBaseFromDid(session.did)` derives the PDS URL from the DID (always `did:web:NNN.fid.is`), not from the handle (which could be `FNAME.farcaster.social`).
6. **Custom DNS handles**: Deferred. FNAME handles cover the primary use case.
