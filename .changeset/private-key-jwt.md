---
"@getcirrus/oauth-provider": minor
---

Add private_key_jwt client authentication and fix response_mode default

- Implement RFC 7523 JWT Bearer client authentication for confidential OAuth clients
- Add `private_key_jwt` to `token_endpoint_auth_methods_supported` in metadata
- Support inline JWKS and remote JWKS URI for client public keys
- Fix default `response_mode` from `fragment` to `query` for authorization code flow
- Add `userinfo_endpoint` to OAuth server metadata
