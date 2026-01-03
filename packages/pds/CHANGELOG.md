# @getcirrus/pds

## 0.2.3

### Patch Changes

- [#48](https://github.com/ascorbic/cirrus/pull/48) [`8362bae`](https://github.com/ascorbic/cirrus/commit/8362bae095b37cdf4a4d9c5232fe3ed55d201531) Thanks [@ascorbic](https://github.com/ascorbic)! - Deprecate packages in favor of @getcirrus/pds and @getcirrus/oauth-provider

  These packages have been renamed and will no longer receive updates under the @ascorbic scope. Please migrate to the new package names:
  - `@ascorbic/pds` → `@getcirrus/pds`
  - `@ascorbic/atproto-oauth-provider` → `@getcirrus/oauth-provider`

- Updated dependencies [[`8362bae`](https://github.com/ascorbic/cirrus/commit/8362bae095b37cdf4a4d9c5232fe3ed55d201531)]:
  - @ascorbic/atproto-oauth-provider@0.1.1

## 0.2.2

### Patch Changes

- [#35](https://github.com/ascorbic/atproto-worker/pull/35) [`735981d`](https://github.com/ascorbic/atproto-worker/commit/735981d036938e8ee6416029ea02329a022048ab) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Return HTTP 403 with AccountDeactivated error for write operations on deactivated accounts

  Previously, attempting write operations on a deactivated account returned a generic 500 error. Now returns a proper 403 Forbidden with error type "AccountDeactivated", giving clients clear feedback that the account needs to be activated.

- [#44](https://github.com/ascorbic/atproto-worker/pull/44) [`0adeffb`](https://github.com/ascorbic/atproto-worker/commit/0adeffbbca35994317451ecde2830fdf4bb5cb33) Thanks [@ascorbic](https://github.com/ascorbic)! - Improvements to CLI prompts and logic

## 0.2.1

### Patch Changes

- [`abcf913`](https://github.com/ascorbic/atproto-worker/commit/abcf91361a7c25ce3cdc5fb0c2f8eea610fcc6c5) Thanks [@ascorbic](https://github.com/ascorbic)! - Correctly migrate preferences

## 0.2.0

### Minor Changes

- [#33](https://github.com/ascorbic/atproto-worker/pull/33) [`4f5b50c`](https://github.com/ascorbic/atproto-worker/commit/4f5b50c4911514f0f87dc3f3856a2b4e2ccb9b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Implement deactivated account pattern for seamless account migration

  **Account State Management:**
  - Add account activation state tracking to support migration workflows
  - New `INITIAL_ACTIVE` environment variable controls whether accounts start active or deactivated
  - Accounts can transition between active and deactivated states

  **Migration Endpoints:**
  - `POST /xrpc/com.atproto.server.activateAccount` - Enable writes and firehose events
  - `POST /xrpc/com.atproto.server.deactivateAccount` - Disable writes while keeping reads available
  - Enhanced `getAccountStatus` to return actual activation state and migration metrics

  **Write Protection:**
  - Write operations (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`) are blocked when account is deactivated
  - Returns clear "AccountDeactivated" error with helpful instructions
  - Read operations, `importRepo`, `uploadBlob`, and `activateAccount` remain available

  **Improved Setup Flow:**
  - `pds init` now asks if you're migrating an existing account
  - For migrations: auto-resolves handle to DID, deploys account as deactivated
  - For new accounts: generates identity, deploys as active
  - Worker name automatically generated from handle using smart slugification

  **Migration UX:**
  - Handle resolution using DNS-over-HTTPS via `@atproto-labs/handle-resolver`
  - Retry logic with helpful error messages for failed handle lookups
  - Step-by-step guidance for export, import, PLC update, and activation
  - Custom domain validation to prevent using hosted handles (\*.bsky.social)

  This enables users to safely migrate their Bluesky accounts to self-hosted infrastructure with a clean, resumable workflow.

### Patch Changes

- Updated dependencies [[`4f5b50c`](https://github.com/ascorbic/atproto-worker/commit/4f5b50c4911514f0f87dc3f3856a2b4e2ccb9b4d)]:
  - @ascorbic/atproto-oauth-provider@0.1.0

## 0.1.0

### Minor Changes

- [#26](https://github.com/ascorbic/atproto-worker/pull/26) [`407eaba`](https://github.com/ascorbic/atproto-worker/commit/407eaba441ab0e6c6a763cdb407635b1e72227da) Thanks [@ascorbic](https://github.com/ascorbic)! - Add `com.atproto.server.getServiceAuth` endpoint for video upload authentication

  This endpoint is required for video uploads. Clients call it to get a service JWT to authenticate with external services like the video service (`did:web:video.bsky.app`).

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
