---
"@getcirrus/oauth-provider": minor
"@getcirrus/pds": patch
---

Advertise a `jwks_uri` in OAuth authorization-server metadata and serve an empty JWKS at `/oauth/jwks`. OAuth clients that run JWKS discovery against the metadata endpoint no longer fail when talking to Cirrus. The key set is empty because Cirrus signs access tokens with HS256 (symmetric `JWT_SECRET`) — there are no public keys to publish.
