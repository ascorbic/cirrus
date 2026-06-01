---
"@getcirrus/pds": patch
---

Be explicit with CORS headers so browser-based authenticated XRPC calls work (particularly PDS Moover).

The CORS middleware advertised `Access-Control-Allow-Headers: *`, but the Fetch spec calls out that `*` wildcard does not cover the `Authorization` header — browsers require it to be named explicitly. As a result, authed cross-origin requests from web clients (eg. PDS Moover's `com.pdsmoover.backup.getRepoStatus`) were blocked at preflight. As `*` can't be used with other headers, all allowed headers are now listed explicitly.
