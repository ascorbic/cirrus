---
"@getcirrus/pds": patch
---

Fix blob uploads intermittently desyncing the PDS from the relay.

Uploading a blob (commonly a link-card thumbnail) could occasionally fail and leave the relay no longer tracking the repo, so new posts stopped federating until a manual crawl request. Blob uploads are now reliable and no longer drop the firehose connection.
