---
"@getcirrus/oauth-provider": minor
"@getcirrus/pds": minor
---

Support granular OAuth permissions and permission sets per the atproto permission spec.

- `repo:`, `rpc:`, `blob:`, `account:`, `identity:` scopes are parsed and enforced (via `@atproto/oauth-scopes`); `transition:generic` / `transition:email` / `transition:chat.bsky` keep working through the transitional shim.
- `verifyAccessToken` now accepts a `(perms) => p.assertRepo({ collection, action })`-style check callback in addition to the legacy required-scope string.
- PDS write endpoints (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`, `uploadBlob`) assert the matching scope before dispatching.
- `include:NSID?aud=...` permission-set scopes are resolved via `@atcute/lexicon-resolver` and expanded inline at code-issuance time, so resource-server checks never need network access. The PDS caches resolved permission sets in DO SQLite with the spec's stale-while-revalidate semantics (24h soft / 90d hard).
- The consent UI groups long granular-scope lists by NSID authority and collapses them behind a `<details>` disclosure, so a 30-scope client like tangled.org renders as a few audit-friendly lines instead of a wall of text. `include:` scopes render the resolved bundle's title/detail.

**Note on legacy auth:** session JWTs (from `createSession` / app-password flow), service JWTs, and the static `AUTH_TOKEN` continue to bypass scope checks at resource handlers — they're treated as fully-trusted callers per their original semantics (app-password equivalents). The new `rpc:` proxy enforcement only applies to OAuth (`DPoP`) tokens; legacy clients can still call any AppView method via the proxy regardless of granular scopes.
