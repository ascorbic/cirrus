# @getcirrus/pds

## 0.6.0

### Minor Changes

- [#88](https://github.com/ascorbic/cirrus/pull/88) [`356735e`](https://github.com/ascorbic/cirrus/commit/356735e92daff0354c8238728029c072a4b1952b) Thanks [@ascorbic](https://github.com/ascorbic)! - Add passkey (WebAuthn) support for passwordless authentication

  **PDS package:**
  - New CLI commands: `pds passkey add`, `pds passkey list`, `pds passkey remove`
  - QR code display in terminal for easy mobile registration
  - Passkey storage and management via Durable Object RPC

  **OAuth provider:**
  - Passkey login option on authorization page
  - Cross-device authentication support (scan QR code from phone)
  - Automatic passkey discovery for returning users

### Patch Changes

- Updated dependencies [[`356735e`](https://github.com/ascorbic/cirrus/commit/356735e92daff0354c8238728029c072a4b1952b), [`7074a27`](https://github.com/ascorbic/cirrus/commit/7074a2707797c6e0d1aace48ab02ca783c43e85e)]:
  - @getcirrus/oauth-provider@0.3.0

## 0.5.0

### Minor Changes

- [#81](https://github.com/ascorbic/cirrus/pull/81) [`688d141`](https://github.com/ascorbic/cirrus/commit/688d1414bd7dc3e4ea1f731ce22f7271f96b2f2a) Thanks [@ascorbic](https://github.com/ascorbic)! - Raise blob size limit from 5MB to 60MB

### Patch Changes

- Updated dependencies [[`e5507d1`](https://github.com/ascorbic/cirrus/commit/e5507d1ced8ed70e2981b737978d97967e4e8cd8)]:
  - @getcirrus/oauth-provider@0.2.1

## 0.4.1

### Patch Changes

- [#77](https://github.com/ascorbic/cirrus/pull/77) [`2ea70ce`](https://github.com/ascorbic/cirrus/commit/2ea70ceb8a52de50787d06e38e1ddb5b31a051d2) Thanks [@ascorbic](https://github.com/ascorbic)! - Add /oauth/userinfo endpoint

  Returns the user's DID (sub) and handle (preferred_username) for OpenID Connect compatibility.

- Updated dependencies [[`2ea70ce`](https://github.com/ascorbic/cirrus/commit/2ea70ceb8a52de50787d06e38e1ddb5b31a051d2)]:
  - @getcirrus/oauth-provider@0.2.0

## 0.4.0

### Minor Changes

- [#74](https://github.com/ascorbic/cirrus/pull/74) [`0d4813e`](https://github.com/ascorbic/cirrus/commit/0d4813ea326cc16623c42213d3020dbc9a1d93aa) Thanks [@ascorbic](https://github.com/ascorbic)! - Add pre-activation checks and emit-identity command

  **activate command improvements:**
  - Run identity checks before activation (handle resolution, DID document, repo status)
  - Display clear results table with pass/fail status
  - Require confirmation if checks fail (skip with `--yes`)
  - Verify activation succeeded after calling the endpoint
  - Offer to emit identity event if all checks passed
  - Add `--yes` / `-y` flag to skip confirmation prompts

  **deactivate command improvements:**
  - Run identity checks to inform user of current state before deactivating
  - Add `--yes` / `-y` flag to skip confirmation prompts

  **New emit-identity command:**
  - Standalone `pds emit-identity` command to notify relays to refresh handle verification
  - Useful after migration or handle changes

  **Internal changes:**
  - Moved emit identity endpoint from `/admin/emit-identity` to XRPC namespace `gg.mk.experimental.emitIdentityEvent`

### Patch Changes

- [#67](https://github.com/ascorbic/cirrus/pull/67) [`a633fb7`](https://github.com/ascorbic/cirrus/commit/a633fb77893bb28a1fbf8d38e8c5a009357db3fd) Thanks [@JackDallas](https://github.com/JackDallas)! - Create user's bsky profile as part of the activate script

- [#76](https://github.com/ascorbic/cirrus/pull/76) [`d6c2eb5`](https://github.com/ascorbic/cirrus/commit/d6c2eb5f3ddbaf4f9db6e0bdf5c36d49b084d728) Thanks [@ascorbic](https://github.com/ascorbic)! - Add relay status check to `pds status` command
  - Added `getRelayHostStatus` method to PDSClient that calls `com.atproto.sync.getHostStatus` on the relay
  - Status command now shows relay status (active/idle/offline/throttled/banned) and account count
  - Shows relay seq number when available
  - Suggests running `emit-identity` or requesting crawl when relay shows idle/offline

## 0.3.1

### Patch Changes

- [#71](https://github.com/ascorbic/cirrus/pull/71) [`a696032`](https://github.com/ascorbic/cirrus/commit/a696032449107b6144946036f4e77769487d9bd9) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix foreign DID requests returning 404 for repo endpoints

  Previously, `getRecord`, `listRecords`, and `describeRepo` returned 404 when the requested repo DID didn't match the local PDS DID. Now these endpoints proxy foreign DID requests to the Bluesky AppView, enabling clients to fetch records from other users' repositories.

## 0.3.0

### Minor Changes

- [#57](https://github.com/ascorbic/cirrus/pull/57) [`20ca34d`](https://github.com/ascorbic/cirrus/commit/20ca34d0170261f920ecde06a155f64688a134a4) Thanks [@ascorbic](https://github.com/ascorbic)! - Add `pds status` CLI command for comprehensive PDS health and configuration checks
  - Enhanced `/xrpc/_health` endpoint to verify Durable Object and SQLite storage health
  - New `pds status` command checks connectivity, repository state, identity resolution, blob import progress, federation status, and account activation
  - Shows DID resolution method (plc.directory or well-known) and handle verification method (DNS TXT and/or HTTP well-known)
  - Added authenticated `/xrpc/gg.mk.experimental.getFirehoseStatus` endpoint for firehose subscriber info

- [#62](https://github.com/ascorbic/cirrus/pull/62) [`af0fde8`](https://github.com/ascorbic/cirrus/commit/af0fde8051024e62ba7c0f98cce53e2e91790b57) Thanks [@ascorbic](https://github.com/ascorbic)! - Ping the Bluesky relay on account activation. The `pds activate` command now calls `com.atproto.sync.requestCrawl` on bsky.network to notify the relay that the PDS is ready for federation. If the account is already active, running `pds activate` again will offer to retry notifying the relay.

### Patch Changes

- [#56](https://github.com/ascorbic/cirrus/pull/56) [`fed94a4`](https://github.com/ascorbic/cirrus/commit/fed94a462d817d23445dcb53654d6f1461b8781e) Thanks [@JackDallas](https://github.com/JackDallas)! - Add custom domain routing to `pds init` - sets up `routes` with `custom_domain: true` so `wrangler deploy` configures DNS automatically

- [#65](https://github.com/ascorbic/cirrus/pull/65) [`30910f7`](https://github.com/ascorbic/cirrus/commit/30910f71596b04947a0c157acd4bf6edb3a3d298) Thanks [@ascorbic](https://github.com/ascorbic)! - Switch to atcute for most internal protocol handling

- [#68](https://github.com/ascorbic/cirrus/pull/68) [`a537cc6`](https://github.com/ascorbic/cirrus/commit/a537cc66b2defc8e64c986dc085cb50460f2421f) Thanks [@ascorbic](https://github.com/ascorbic)! - fix: correctly encode identity events

- [#56](https://github.com/ascorbic/cirrus/pull/56) [`fed94a4`](https://github.com/ascorbic/cirrus/commit/fed94a462d817d23445dcb53654d6f1461b8781e) Thanks [@JackDallas](https://github.com/JackDallas)! - Add multi-account selection to `pds init` - detects multiple Cloudflare accounts via `wrangler whoami` and prompts user to select one

- [#58](https://github.com/ascorbic/cirrus/pull/58) [`adedb2b`](https://github.com/ascorbic/cirrus/commit/adedb2b075f3a6819b1de03996eff3c9a1c618b9) Thanks [@ascorbic](https://github.com/ascorbic)! - Respect user's package manager choice in CLI commands. All CLI commands (init, migrate, activate, deactivate) now detect and use the user's package manager consistently. Changed `wrangler deploy` references to use the appropriate package manager command (e.g., `pnpm run deploy`).

- Updated dependencies [[`95ffff6`](https://github.com/ascorbic/cirrus/commit/95ffff6766325822fe621ff82f1c3ab8850dcdea), [`30910f7`](https://github.com/ascorbic/cirrus/commit/30910f71596b04947a0c157acd4bf6edb3a3d298)]:
  - @getcirrus/oauth-provider@0.1.3

## 0.2.5

### Patch Changes

- [#53](https://github.com/ascorbic/cirrus/pull/53) [`5d21116`](https://github.com/ascorbic/cirrus/commit/5d21116b32f72e43c4d1537add9e09e9392b10ec) Thanks [@ascorbic](https://github.com/ascorbic)! - Serve a page from the index

## 0.2.4

### Patch Changes

- [#47](https://github.com/ascorbic/cirrus/pull/47) [`b4de6fa`](https://github.com/ascorbic/cirrus/commit/b4de6fa1117d37a6df4fa271404544f883757e07) Thanks [@ascorbic](https://github.com/ascorbic)! - Rename to Cirrus

- Updated dependencies [[`b4de6fa`](https://github.com/ascorbic/cirrus/commit/b4de6fa1117d37a6df4fa271404544f883757e07)]:
  - @getcirrus/oauth-provider@0.1.2

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
