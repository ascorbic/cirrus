---
"@getcirrus/pds": patch
---

Be explicit with CORS headers so browser-based authenticated XRPC calls work (particularly PDS Moover).

The CORS middleware advertised `Access-Control-Allow-Headers: *`, but this didn't cover the `Authorization` header needed by tools like PDS Moover. As a result, authed cross-origin requests from web clients (eg. PDS Moover's `com.pdsmoover.backup.getRepoStatus`) were blocked at preflight. This is now resolved; all headers are reflected back, just like the Bluesky implementation.
