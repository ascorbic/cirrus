# create-pds

## 0.0.11

### Patch Changes

- [#97](https://github.com/ascorbic/cirrus/pull/97) [`55fc14f`](https://github.com/ascorbic/cirrus/commit/55fc14fd06de5827fd4cb94ccbdad2145aae6a18) Thanks [@JoshuaACasey](https://github.com/JoshuaACasey)! - Fix missing comma in generated wrangler.jsonc

## 0.0.10

### Patch Changes

- [#95](https://github.com/ascorbic/cirrus/pull/95) [`11d1f70`](https://github.com/ascorbic/cirrus/commit/11d1f70f6f9b11d8632dad2733b229ceb8107a00) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix service JWT expiry for video uploads

  Extended the service JWT expiry from 60 seconds to 5 minutes. This fixes video upload failures where larger videos would take longer than 60 seconds to process on video.bsky.app, causing the callback to your PDS to fail with 401 due to the expired JWT.

  Also enables observability in the Cloudflare Worker template for better debugging.

## 0.0.9

### Patch Changes

- [#87](https://github.com/ascorbic/cirrus/pull/87) [`98a07df`](https://github.com/ascorbic/cirrus/commit/98a07df5d864133c9e76a7aae0f58a231ff1924f) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix npm command in next steps message

  The CLI now correctly displays `npm run dev` instead of `npm dev` when npm is selected as the package manager. This ensures users receive valid commands that will actually work.

## 0.0.8

### Patch Changes

- [#51](https://github.com/ascorbic/cirrus/pull/51) [`a2aea3a`](https://github.com/ascorbic/cirrus/commit/a2aea3a4f29f2c358ee6ead13f0c333a2e0d20e2) Thanks [@ascorbic](https://github.com/ascorbic)! - Don't attempt to run init if dependencies haven't been installed

## 0.0.7

### Patch Changes

- [#47](https://github.com/ascorbic/cirrus/pull/47) [`b4de6fa`](https://github.com/ascorbic/cirrus/commit/b4de6fa1117d37a6df4fa271404544f883757e07) Thanks [@ascorbic](https://github.com/ascorbic)! - Rename to Cirrus

## 0.0.6

### Patch Changes

- [#44](https://github.com/ascorbic/atproto-worker/pull/44) [`0adeffb`](https://github.com/ascorbic/atproto-worker/commit/0adeffbbca35994317451ecde2830fdf4bb5cb33) Thanks [@ascorbic](https://github.com/ascorbic)! - Improvements to CLI prompts and logic

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
