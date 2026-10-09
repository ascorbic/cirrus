# @getcirrus/spaces

## 0.1.1

### Patch Changes

- [#255](https://github.com/ascorbic/cirrus/pull/255) [`de476f5`](https://github.com/ascorbic/cirrus/commit/de476f57ba1fb936c6480a8fc278b6c7fc250cab) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix fresh installs failing with `"@atproto/lex-data@workspace:*" is in the dependencies but no package named "@atproto/lex-data" is present in the workspace` (or `Unsupported URL Type "workspace:"` under npm). This affected new projects created with `create-pds`, as well as any project installing these packages without an existing lockfile.

## 0.1.0

### Minor Changes

- [#219](https://github.com/ascorbic/cirrus/pull/219) [`5762e22`](https://github.com/ascorbic/cirrus/commit/5762e22a9ece71a83eb4b3d67ae5a773c637ee7d) Thanks [@ascorbic](https://github.com/ascorbic)! - First release of `@getcirrus/spaces`: the atproto spaces engine (alpha) for Cloudflare Workers. Provides the per-space and index Durable Objects, permissioned repo storage with LtHash commits and oplog sync, space credential / delegation / DPoP / client-attestation verification, simplespace policies, and the Hono route factory for `com.atproto.space.*` and `com.atproto.simplespace.*`, all behind the host PDS's `SPACES_ENABLED` flag.
