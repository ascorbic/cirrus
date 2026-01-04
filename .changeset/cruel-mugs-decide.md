---
"@getcirrus/pds": patch
---

Fix foreign DID requests returning 404 for repo endpoints

Previously, `getRecord`, `listRecords`, and `describeRepo` returned 404 when the requested repo DID didn't match the local PDS DID. Now these endpoints proxy foreign DID requests to the Bluesky AppView, enabling clients to fetch records from other users' repositories.
