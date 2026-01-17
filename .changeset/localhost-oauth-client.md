---
"@getcirrus/oauth-provider": patch
---

Fix OAuth for localhost clients per AT Protocol spec

Localhost clients (using `http://localhost` as client_id) are now accepted per the AT Protocol OAuth specification. This enables local development tools and CLI applications to authenticate without requiring a registered client.

- Added `isLocalhostClientId()` helper to detect localhost client URIs
- Updated `ClientResolver` to generate metadata for localhost clients dynamically
- Localhost clients are treated as public clients with no client authentication
- Redirect URIs must use `http://127.0.0.1` with any port (per spec requirement)
