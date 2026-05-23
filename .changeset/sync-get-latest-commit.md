---
"@getcirrus/pds": minor
---

Implement `com.atproto.sync.getLatestCommit`.

This sync XRPC endpoint was previously unimplemented, so requests fell through to the XRPC proxy and returned `501 MethodNotImplemented`. Relays call `getLatestCommit` during their crawl bootstrap, so a freshly created repo could never be indexed by a fresh `requestCrawl`. The endpoint now returns the repo's head commit as `{ cid, rev }` (sourced from the same `rpcGetRepoStatus` data used by `getRepoStatus`/`listRepos`).
