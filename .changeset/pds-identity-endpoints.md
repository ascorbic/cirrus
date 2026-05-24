---
"@getcirrus/pds": minor
---

Implement three PDS-side identity endpoints that previously fell through to the AppView proxy and returned 501:

- `com.atproto.identity.resolveDid` returns the DID document for the local account.
- `com.atproto.identity.resolveIdentity` returns `{did, handle, didDoc}` for the local handle or DID.
- `com.atproto.identity.getRecommendedDidCredentials` (authenticated) returns the rotation keys, `alsoKnownAs`, verification methods, and PDS service entry that a migrating account should advertise.

Requests for foreign DIDs or handles continue to fall through to the AppView proxy unchanged.
