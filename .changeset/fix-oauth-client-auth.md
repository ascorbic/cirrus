---
"@getcirrus/oauth-provider": patch
---

Fix OAuth client authentication failures for public clients and mixed JWKS

- Fix `invalid_client` error for clients that omit `token_endpoint_auth_method` in their metadata (Zod default of `client_secret_basic` was passed through unsupported)
- Fix `invalid usage "encrypt"` error when client JWKS contains both signing and encryption keys by using jose's `createLocalJWKSet` for proper key selection
