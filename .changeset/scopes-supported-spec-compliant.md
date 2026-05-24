---
"@getcirrus/oauth-provider": patch
---

`scopes_supported` in the authorization-server metadata now lists only the values the spec calls out: `atproto`, `transition:generic`, `transition:email`, `transition:chat.bsky`. Granular resource scopes (`repo:<nsid>`, `rpc:<lxm>`, `blob:<mime>`, `account:<…>`, `identity:<…>`) and permission-set scopes (`include:<nsid>`) are parameterised and aren't enumerable, so bare prefixes like `repo` or `include` are no longer advertised — clients discover support by attempting the scope and falling back on `invalid_scope`, matching the reference PDS.
