---
"@getcirrus/pds": minor
---

Add `pds status` CLI command for comprehensive PDS health and configuration checks

- Enhanced `/xrpc/_health` endpoint to verify Durable Object and SQLite storage health
- New `pds status` command checks connectivity, repository state, identity resolution, blob import progress, federation status, and account activation
- Shows DID resolution method (plc.directory or well-known) and handle verification method (DNS TXT and/or HTTP well-known)
- Added authenticated `/xrpc/gg.mk.experimental.getFirehoseStatus` endpoint for firehose subscriber info
