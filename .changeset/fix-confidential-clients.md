---
"@getcirrus/oauth-provider": patch
---

Fix support for confidential OAuth clients with remote JWKS (like leaflet.pub):
- Accept issuer URL as valid JWT audience (not just token endpoint)
- Invalidate stale cache entries missing tokenEndpointAuthMethod
