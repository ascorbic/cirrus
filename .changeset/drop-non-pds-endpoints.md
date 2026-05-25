---
"@getcirrus/pds": minor
---

Remove `com.atproto.identity.resolveDid`, `com.atproto.identity.resolveIdentity`, and `com.atproto.sync.listReposByCollection` handlers. These lexicons are implemented by the directory and relay layers, not the PDS — the reference @atproto PDS doesn't expose them either. Requests for these methods now fall through to the AppView proxy like any other unknown XRPC call.
