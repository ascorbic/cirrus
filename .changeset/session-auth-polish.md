---
"@getcirrus/pds": patch
---

Fix three conformance issues found by pdscheck:

- `com.atproto.server.getSession` now accepts OAuth access tokens presented with the `DPoP` scheme (RFC 9449), not just `Bearer`. OAuth clients can now read session info without first being rejected with 401.
- `com.atproto.server.listAppPasswords` returns `createdAt` as an RFC 3339 datetime (e.g. `2026-03-29T15:30:17.000Z`) instead of the SQLite `"YYYY-MM-DD HH:MM:SS"` form that violated the lexicon.
- `com.atproto.server.getAccountInviteCodes` is now implemented and returns `{ codes: [] }` for authenticated callers (Cirrus has `inviteCodeRequired: false`, so there are no invite codes to list). Previously it fell through to the AppView proxy and returned 501.
