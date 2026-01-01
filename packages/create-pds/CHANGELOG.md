# create-pds

## 0.0.5

### Patch Changes

- [#37](https://github.com/ascorbic/atproto-worker/pull/37) [`0a68fbe`](https://github.com/ascorbic/atproto-worker/commit/0a68fbec25b639aef2450e163ed5a5de05c03746) Thanks [@ascorbic](https://github.com/ascorbic)! - Fetch latest @ascorbic/pds version from npm registry when creating a new project

## 0.0.4

### Patch Changes

- [#33](https://github.com/ascorbic/atproto-worker/pull/33) [`4f5b50c`](https://github.com/ascorbic/atproto-worker/commit/4f5b50c4911514f0f87dc3f3856a2b4e2ccb9b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Improve UX with clearer prompts

## 0.0.3

### Patch Changes

- [#23](https://github.com/ascorbic/atproto-worker/pull/23) [`d7bf601`](https://github.com/ascorbic/atproto-worker/commit/d7bf6013924da6867c1779face55b2ccc91f3849) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix signing key serialization format and improve CLI
  - Fix signing key export to use hex encoding instead of JSON (was causing import failures)
  - Add `@types/node` to create-pds template
  - Suppress install and wrangler types output unless there's an error
  - Add initial git commit after install, and commit after pds init
  - Extract shared secret generation utilities for CLI commands
  - Add tests for signing key serialization

## 0.0.2

### Patch Changes

- [`8a3f1c3`](https://github.com/ascorbic/atproto-worker/commit/8a3f1c3c4352cd63890bad50e3499655ea89982f) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial release

## 0.0.1

### Patch Changes

- [`648d05c`](https://github.com/ascorbic/atproto-worker/commit/648d05cb4854b6af8061ce68250068ac1b061912) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial release
