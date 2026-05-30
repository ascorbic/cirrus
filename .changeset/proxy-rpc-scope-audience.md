---
"@getcirrus/pds": patch
---

Fix OAuth scope checking when proxying XRPC requests. Granular `rpc:` scopes are granted against the full `did#service_id` audience, but the proxy was checking them against the bare DID, so any granular (non-`aud=*`) scope was rejected. Proxied requests now check scope against the full service audience, while the outbound service-auth JWT continues to use the bare DID.
