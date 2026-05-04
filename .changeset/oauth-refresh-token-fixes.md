---
"@getcirrus/oauth-provider": patch
"@getcirrus/pds": patch
---

Fix two OAuth token refresh bugs that prevented spec-compliant clients (e.g. tangled.org via indigo) from refreshing their session after the access token expired.

- Track access and refresh expiry separately on `TokenData` (`accessExpiresAt` / `refreshExpiresAt`) instead of a single `expiresAt`. `cleanup()` now prunes by `refreshExpiresAt`, so a row isn't deleted while its refresh token is still valid. The PDS SQLite store migrates legacy `oauth_tokens` rows in place, deriving `refresh_expires_at` as `MAX(expires_at, issued_at + REFRESH_TOKEN_TTL)`.
- The PDS auth middleware now sends `WWW-Authenticate: DPoP error="invalid_token"` on 401 responses for invalid/expired OAuth access tokens, as required by the atproto XRPC spec. Clients that gate refresh on this header (indigo, and others) will now refresh automatically instead of staying logged-in-but-broken until the user signs out.
