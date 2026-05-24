---
"@getcirrus/oauth-provider": patch
---

Fix `parseScope` rejecting valid granular scopes that use the query-only form (e.g. `repo?collection=a&collection=b`) with `Unknown scope resource`. The parser previously only looked for `:` as the prefix delimiter, but per `@atproto/oauth-scopes` syntax a scope can use `prefix:positional`, `prefix?query`, or both. This affected permission sets whose `repo` permission listed multiple collections, since those expand to a single query-form token.
