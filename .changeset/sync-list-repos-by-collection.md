---
"@getcirrus/pds": minor
---

Implement `com.atproto.sync.listReposByCollection`.

Relays and crawlers use this endpoint to discover which PDSes host repos that contain a given record collection. The PDS now answers with `{ repos: [{ did }] }` when its account has at least one record in the requested collection, or an empty list otherwise. Invalid or missing `collection` parameters return `InvalidRequest`.
