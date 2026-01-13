---
"@getcirrus/pds": patch
---

Fix automatic token refresh not triggering after access token expiry

Fixes the authentication loss issue where Cirrus-hosted accounts would lose auth after ~2 hours, requiring users to switch accounts or reload the page to recover.

**Root Cause:**
The Bluesky client's `fetchHandler` specifically checks for HTTP 400 with error code `'ExpiredToken'` to trigger automatic token refresh. Cirrus was returning HTTP 401 with `'InvalidToken'`, which the client interpreted as "token is fundamentally broken" rather than "token expired, please refresh".

**Fixes:**
1. Return HTTP 400 with `'ExpiredToken'` for expired access tokens (matching official PDS)
2. Added `TokenExpiredError` class to detect `jose.errors.JWTExpired` specifically
3. Fixed JWT scope to use `'com.atproto.access'` (matching official PDS)
4. Removed duplicate `jti` from refresh token payload
5. Removed JWT `iss` claim to match official PDS
6. Added `emailConfirmed` field to session responses
