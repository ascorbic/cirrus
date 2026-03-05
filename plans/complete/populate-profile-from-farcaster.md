# Populate Bluesky Profile from Farcaster Data on Account Creation

## Status: Complete

Implemented in the miniapp (client-side) rather than the PDS (server-side) as originally planned.

## Overview

When a new account is created, the miniapp automatically populates the user's `app.bsky.actor.profile` record with their Farcaster identity data (display name, bio, avatar). This runs after account creation as a best-effort step — failures are silently ignored.

## Data Sources

**Hub API** (`hub.pinata.cloud/v1/userDataByFid?fid={fid}`, public, no auth):
- `USER_DATA_TYPE_DISPLAY` → `displayName` (truncated to 64 chars)
- `USER_DATA_TYPE_BIO` → `description` (truncated to 256 chars)
- `USER_DATA_TYPE_PFP` → avatar URL (downloaded, uploaded as blob, max 1MB)
- `USER_DATA_TYPE_USERNAME` → `username` (e.g. ENS name)
- `USER_DATA_TYPE_URL` → `url`
- `USER_DATA_TYPE_PRIMARY_ADDRESS_ETHEREUM` → `ethAddress`

**FNAME registry** (`fnames.farcaster.xyz/transfers?fid={fid}`):
- Latest transfer `username` → `fname` (used for handle selection, not profile)

Both are fetched in parallel with 5s timeouts, errors silently caught.

## Implementation

### `apps/miniapp/src/api.ts`

- `FarcasterProfile` interface — holds all fetched fields
- `fetchFarcasterProfile(fid)` — fetches Hub API + FNAME registry in parallel, returns `FarcasterProfile`
- `populateProfile(accessToken, pdsBase, did, profile)` — builds `app.bsky.actor.profile` record:
  1. Downloads avatar from `pfpUrl` (10s timeout, ≤1MB)
  2. Detects MIME from magic bytes (JPEG, PNG, WebP, GIF supported)
  3. Uploads via `com.atproto.repo.uploadBlob`
  4. Writes profile via `com.atproto.repo.putRecord` (collection `app.bsky.actor.profile`, rkey `self`)
  5. Entire function is try/catch — best-effort, doesn't fail account creation
- `uploadBlob(accessToken, pdsBase, bytes, mimeType)` — helper for blob upload
- `detectImageMime(bytes)` — magic byte detection for JPEG, PNG, WebP, GIF

### `apps/miniapp/src/App.tsx`

- `finalizeNewAccount(session, profile)` — called after account creation, runs `populateProfile()` then `requestCrawl()`
- Profile is fetched early (during auth flow, in parallel with account status check) so it's ready by the time account creation completes
- Profile data is also displayed in the `ConfirmCreateScreen` as a preview (avatar, display name, bio)

## Design Decision: Client-Side vs Server-Side

The original plan proposed implementing this in the PDS (`packages/pds/src/farcaster-profile.ts`) using `waitUntil` for background execution. Instead, it was implemented in the miniapp because:

- Profile population uses standard AT Protocol endpoints (`putRecord`, `uploadBlob`) — no special PDS logic needed
- The miniapp already fetches the profile for UI preview, so the data is already available
- Keeps the PDS focused on protocol operations, not Farcaster-specific logic
