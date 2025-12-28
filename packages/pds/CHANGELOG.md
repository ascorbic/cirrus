# @ascorbic/pds

## 0.0.2

### Patch Changes

- [#23](https://github.com/ascorbic/atproto-worker/pull/23) [`d7bf601`](https://github.com/ascorbic/atproto-worker/commit/d7bf6013924da6867c1779face55b2ccc91f3849) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix signing key serialization format and improve CLI
  - Fix signing key export to use hex encoding instead of JSON (was causing import failures)
  - Add `@types/node` to create-pds template
  - Suppress install and wrangler types output unless there's an error
  - Add initial git commit after install, and commit after pds init
  - Extract shared secret generation utilities for CLI commands
  - Add tests for signing key serialization

## 0.0.1

### Patch Changes

- [`648d05c`](https://github.com/ascorbic/atproto-worker/commit/648d05cb4854b6af8061ce68250068ac1b061912) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial release
