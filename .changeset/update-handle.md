---
"@getcirrus/pds": minor
---

Support changing your handle from apps like Bluesky. `com.atproto.identity.updateHandle` was not implemented, so the request was forwarded to the AppView and failed with "Failed to change handle". The PDS now checks that the new handle resolves to your DID, updates your PLC record for did:plc accounts when its signing key is a rotation key, stores the handle, and emits an identity event so relays pick it up. Changing the `HANDLE` variable still works and takes precedence over a handle set this way.
