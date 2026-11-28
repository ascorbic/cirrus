---
"@getcirrus/pds": patch
---

Fixes `pds rotation-keys` failing with `BadJwtSignature` when the previous PDS is a Bluesky host. The command now asks bsky.social for the confirmation code and signature.
