# @getcirrus/pds

## 0.17.1

### Patch Changes

- [#190](https://github.com/ascorbic/cirrus/pull/190) [`5384f54`](https://github.com/ascorbic/cirrus/commit/5384f54d49b863fc4672eeecc72b4895ce4e54bc) Thanks [@ascorbic](https://github.com/ascorbic)! - Match the reference @atproto PDS's exact `RecordNotFound` error message (`Could not locate record: <at-uri>`). The Bluesky social-app's quote-detach flow string-matches this phrase to decide whether to create a new `app.bsky.feed.postgate` record vs. update an existing one; the previous message caused it to rethrow instead of falling through to the create path.

## 0.17.0

### Minor Changes

- [#187](https://github.com/ascorbic/cirrus/pull/187) [`838001e`](https://github.com/ascorbic/cirrus/commit/838001e84b50707958aac2c8383d5a22a13bb7d2) Thanks [@ascorbic](https://github.com/ascorbic)! - Remove `com.atproto.identity.resolveDid`, `com.atproto.identity.resolveIdentity`, and `com.atproto.sync.listReposByCollection` handlers. These lexicons are implemented by the directory and relay layers, not the PDS — the reference @atproto PDS doesn't expose them either. Requests for these methods now fall through to the AppView proxy like any other unknown XRPC call.

### Patch Changes

- [#189](https://github.com/ascorbic/cirrus/pull/189) [`5677603`](https://github.com/ascorbic/cirrus/commit/5677603c90a0e729c8b37b3391cb96239111ff93) Thanks [@ascorbic](https://github.com/ascorbic)! - Align `com.atproto.repo.getRecord` and `com.atproto.repo.deleteRecord` error handling with the reference @atproto PDS:
  - `getRecord` now returns HTTP 400 (not 404) with `RecordNotFound` when the record is missing. The reference PDS raises `InvalidRequestError`, which maps to 400.
  - `deleteRecord` on a missing record is now a 200 no-op (returning an empty body with no commit) instead of `RecordNotFound`, matching the reference PDS.

## 0.16.0

### Minor Changes

- [#179](https://github.com/ascorbic/cirrus/pull/179) [`9f8adee`](https://github.com/ascorbic/cirrus/commit/9f8adeef6ebd009dcdbc76f88da81bfaa7142037) Thanks [@ascorbic](https://github.com/ascorbic)! - Implement three PDS-side identity endpoints that previously fell through to the AppView proxy and returned 501:
  - `com.atproto.identity.resolveDid` returns the DID document for the local account.
  - `com.atproto.identity.resolveIdentity` returns `{did, handle, didDoc}` for the local handle or DID.
  - `com.atproto.identity.getRecommendedDidCredentials` (authenticated) returns the rotation keys, `alsoKnownAs`, verification methods, and PDS service entry that a migrating account should advertise.

  Requests for foreign DIDs or handles continue to fall through to the AppView proxy unchanged.

- [#171](https://github.com/ascorbic/cirrus/pull/171) [`bf2f857`](https://github.com/ascorbic/cirrus/commit/bf2f857b0df9cc9e8eaeb7e336114107596473af) Thanks [@ascorbic](https://github.com/ascorbic)! - The firehose now emits the sync 1.1 message shape, matching what the bsky.network relay and other AT Protocol consumers expect. Existing subscribers will start seeing new fields and new event types; nothing has to change on the consumer side, but the warnings some relays were logging against Cirrus hosts (notably `missing prevData field`) will stop.

  What changed on the wire:
  - `#commit` messages now include `prevData` (the prior commit's MST root CID), so relays can verify each commit inductively without re-fetching the repo. The CAR slice now also carries the MST covering-proof blocks needed for that verification.
  - Each `ops[]` entry on update and delete now includes `prev`, the previous CID of the touched record. Creates omit it as before.
  - `tooBig` is always `false`. It was previously set based on payload size, which never matched the field's meaning under sync 1.1.
  - New `#account` events are emitted on activation and deactivation, so relays learn about account status changes without polling. Deactivation reports `status: "deactivated"`; activation reports `active: true` with no status.
  - New `#sync` events are emitted on activation (after migration or initial setup), giving relays the current commit block without a diff.
  - `#identity` events now allow the `handle` field to be omitted, per spec.
  - A `#info` frame with `name: "OutdatedCursor"` is sent when a client connects with a cursor older than the retained event window. The stream continues from the oldest available event instead of disconnecting.
  - `applyWrites` rejects calls with more than 200 operations, matching the spec cap.

- [#168](https://github.com/ascorbic/cirrus/pull/168) [`71b988e`](https://github.com/ascorbic/cirrus/commit/71b988e485d5128b185fb4970aaa35011bf67e04) Thanks [@simnaut](https://github.com/simnaut)! - Implement `com.atproto.sync.getLatestCommit`.

  This sync XRPC endpoint was previously unimplemented, so requests fell through to the XRPC proxy and returned `501 MethodNotImplemented`. Relays call `getLatestCommit` during their crawl bootstrap, so a freshly created repo could never be indexed by a fresh `requestCrawl`. The endpoint now returns the repo's head commit as `{ cid, rev }` (sourced from the same `rpcGetRepoStatus` data used by `getRepoStatus`/`listRepos`).

- [#178](https://github.com/ascorbic/cirrus/pull/178) [`aceda62`](https://github.com/ascorbic/cirrus/commit/aceda62d0e653c139302dc45b01091886b3234ae) Thanks [@ascorbic](https://github.com/ascorbic)! - Implement `com.atproto.sync.listReposByCollection`.

  Relays and crawlers use this endpoint to discover which PDSes host repos that contain a given record collection. The PDS now answers with `{ repos: [{ did }] }` when its account has at least one record in the requested collection, or an empty list otherwise. Invalid or missing `collection` parameters return `InvalidRequest`.

### Patch Changes

- [#181](https://github.com/ascorbic/cirrus/pull/181) [`6589e1d`](https://github.com/ascorbic/cirrus/commit/6589e1dc854be11164b2ad80d77840ed7820bd4d) Thanks [@ascorbic](https://github.com/ascorbic)! - `applyWrites` now returns the record CID on `createResult` and `updateResult` even when the record is removed later in the same batch. The lexicon marks `cid` as required, but the previous code looked it up in the post-commit MST — for a record that was created then deleted within one batch, the MST has no entry and the field was missing. The CID is now computed from the record bytes up front, matching reference PDS behaviour.

- [#176](https://github.com/ascorbic/cirrus/pull/176) [`36b79fd`](https://github.com/ascorbic/cirrus/commit/36b79fdcabb6d0620b7dc3b184549f9813f6ebcb) Thanks [@ascorbic](https://github.com/ascorbic)! - `com.atproto.repo.applyWrites` now accepts batches that touch the same rkey more than once, matching the reference PDS. The common case is a create followed by a delete on the same rkey within one batch (an atomic no-op pattern several clients rely on); previously Cirrus rejected this with `400 InvalidRequest: duplicate rkey in batch`. Two creates on the same rkey still fail, but now as `409 RecordAlreadyExists` from the repo layer rather than a pre-flight 400.

- [#177](https://github.com/ascorbic/cirrus/pull/177) [`ec284fd`](https://github.com/ascorbic/cirrus/commit/ec284fde3544e9ea4e2b6b085f718de449e4862e) Thanks [@ascorbic](https://github.com/ascorbic)! - Advertise a `jwks_uri` in OAuth authorization-server metadata and serve an empty JWKS at `/oauth/jwks`. OAuth clients that run JWKS discovery against the metadata endpoint no longer fail when talking to Cirrus. The key set is empty because Cirrus signs access tokens with HS256 (symmetric `JWT_SECRET`) — there are no public keys to publish.

- [#180](https://github.com/ascorbic/cirrus/pull/180) [`d107c59`](https://github.com/ascorbic/cirrus/commit/d107c596406b5b7c414f35010ea76d9d5a348b72) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix three conformance issues found by pdscheck:
  - `com.atproto.server.getSession` now accepts OAuth access tokens presented with the `DPoP` scheme (RFC 9449), not just `Bearer`. OAuth clients can now read session info without first being rejected with 401.
  - `com.atproto.server.listAppPasswords` returns `createdAt` as an RFC 3339 datetime (e.g. `2026-03-29T15:30:17.000Z`) instead of the SQLite `"YYYY-MM-DD HH:MM:SS"` form that violated the lexicon.
  - `com.atproto.server.getAccountInviteCodes` is now implemented and returns `{ codes: [] }` for authenticated callers (Cirrus has `inviteCodeRequired: false`, so there are no invite codes to list). Previously it fell through to the AppView proxy and returned 501.

- Updated dependencies [[`ec284fd`](https://github.com/ascorbic/cirrus/commit/ec284fde3544e9ea4e2b6b085f718de449e4862e), [`54ab459`](https://github.com/ascorbic/cirrus/commit/54ab459588393a58ea906977c1ffc8996d8d0700), [`22f09de`](https://github.com/ascorbic/cirrus/commit/22f09def6b2ed644fb88b3f707fde4da35a6f04a), [`47c8c1e`](https://github.com/ascorbic/cirrus/commit/47c8c1e401dff16c3983a2151cffd20bc83551d6), [`aed8e1b`](https://github.com/ascorbic/cirrus/commit/aed8e1b629afe9d2eae6d2d5b9c5265d769b057b)]:
  - @getcirrus/oauth-provider@0.5.0

## 0.15.2

### Patch Changes

- [#165](https://github.com/ascorbic/cirrus/pull/165) [`5e058c8`](https://github.com/ascorbic/cirrus/commit/5e058c8d7141391c761693de53bb6b1a8bb11a74) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix blob uploads intermittently desyncing the PDS from the relay.

  Uploading a blob (commonly a link-card thumbnail) could occasionally fail and leave the relay no longer tracking the repo, so new posts stopped federating until a manual crawl request. Blob uploads are now reliable and no longer drop the firehose connection.

## 0.15.1

### Patch Changes

- [#157](https://github.com/ascorbic/cirrus/pull/157) [`241a5fc`](https://github.com/ascorbic/cirrus/commit/241a5fc58baa429c3938c0b99f9afdd9d5c85dce) Thanks [@NuroDev](https://github.com/NuroDev)! - fix(pds): Remove empty collections from cache on record delete.

  When all records of a collection are deleted, it is now ensured that the collection is deleted from the user repository so collections don't linger around forever

## 0.15.0

### Minor Changes

- [#160](https://github.com/ascorbic/cirrus/pull/160) [`a492bf7`](https://github.com/ascorbic/cirrus/commit/a492bf71e6c6e9c174617a98931ec005e07abbc8) Thanks [@ascorbic](https://github.com/ascorbic)! - Lexicon validation now matches the reference PDS more closely:
  - `createRecord`, `putRecord`, and `applyWrites` honor the `validate` flag from the request body. `true` requires a known schema, `false` skips schema validation, `undefined` validates known schemas optimistically.
  - Responses include `validationStatus` (`"valid"` for known, `"unknown"` for unknown collections; omitted when `validate: false`). Per-write `validationStatus` is returned in `applyWrites` results.
  - The record's `$type` is filled in from `collection` when missing and rejected on mismatch.
  - Generic record-key shape (`isRecordKey`) is enforced for any provided rkey, regardless of `validate` flag — closes a hole where empty-string and path-traversal-style rkeys could reach the repo.
  - Schema-specific record keys are validated against the schema's `keySchema` for known collections (e.g. `app.bsky.feed.post` requires a TID, `app.bsky.actor.profile` requires `self`).
  - Legacy `{ cid, mimeType }` blob refs are rejected.
  - Bundled schema set broadened to include `com.atproto.lexicon.schema`, `app.bsky.actor.status`, `app.bsky.notification.declaration`, and `chat.bsky.actor.declaration`.
  - The Durable Object is now the authoritative rkey allocator: when the client doesn't supply an rkey, the worker validates against a candidate (so restrictive `keySchema`s still reject early) and the DO picks the final rkey against its MST state, with a small retry loop to defeat any worker-isolate clockid collisions.
  - Client-supplied rkey collisions return `409 RecordAlreadyExists` instead of a generic 500.
  - Intra-batch duplicate rkeys in `applyWrites` return `400 InvalidRequest` (distinguished from the 409 above).
  - Missing rkey for `applyWrites#update`/`#delete` returns `400 InvalidRequest`.
  - Non-boolean `validate` flag values return `400 InvalidRequest`.
  - Non-string `rkey` values (including `null`) return `400 InvalidRequest`.

### Patch Changes

- [#162](https://github.com/ascorbic/cirrus/pull/162) [`5920074`](https://github.com/ascorbic/cirrus/commit/5920074d3d1b12935c9e6ef014e422b3e2e503ec) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix relay desync after a failed write (e.g. an image post that errors mid-flight).

  `applyWrites` was assigning the new `Repo` to in-memory state before sequencing the firehose event. If anything threw between then and `sequenceCommit` succeeding, Cloudflare rolled back the SQLite writes but the in-memory `Repo` stayed advanced. The next successful write then emitted a firehose commit whose `since` rev the relay had never seen, and the relay marked the repo desynced — requiring a manual `requestCrawl` to recover.

  `this.repo` is now only assigned after the sequence + broadcast succeed, and any failure in that window invalidates the in-memory cache so the next access reloads from storage.

## 0.14.0

### Minor Changes

- [#158](https://github.com/ascorbic/cirrus/pull/158) [`ec935b1`](https://github.com/ascorbic/cirrus/commit/ec935b16b7f44b22ff325781e0c88ccc3d07e599) Thanks [@ascorbic](https://github.com/ascorbic)! - Support granular OAuth permissions and permission sets per the atproto permission spec.
  - `repo:`, `rpc:`, `blob:`, `account:`, `identity:` scopes are parsed and enforced (via `@atproto/oauth-scopes`); `transition:generic` / `transition:email` / `transition:chat.bsky` keep working through the transitional shim.
  - `verifyAccessToken` now accepts a `(perms) => p.assertRepo({ collection, action })`-style check callback in addition to the legacy required-scope string.
  - PDS write endpoints (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`, `uploadBlob`) assert the matching scope before dispatching.
  - `include:NSID?aud=...` permission-set scopes are resolved via `@atcute/lexicon-resolver` and expanded inline at code-issuance time, so resource-server checks never need network access. The PDS caches resolved permission sets in DO SQLite with the spec's stale-while-revalidate semantics (24h soft / 90d hard).
  - The consent UI groups long granular-scope lists by NSID authority and collapses them behind a `<details>` disclosure, so a 30-scope client like tangled.org renders as a few audit-friendly lines instead of a wall of text. `include:` scopes render the resolved bundle's title/detail.

  **Note on legacy auth:** session JWTs (from `createSession` / app-password flow), service JWTs, and the static `AUTH_TOKEN` continue to bypass scope checks at resource handlers — they're treated as fully-trusted callers per their original semantics (app-password equivalents). The new `rpc:` proxy enforcement only applies to OAuth (`DPoP`) tokens; legacy clients can still call any AppView method via the proxy regardless of granular scopes.

### Patch Changes

- [#153](https://github.com/ascorbic/cirrus/pull/153) [`6e4d81d`](https://github.com/ascorbic/cirrus/commit/6e4d81dbf065568a273739ee59e97870381d5e68) Thanks [@georgemblack](https://github.com/georgemblack)! - Fix `com.atproto.server.checkAccountStatus` response to be lexicon-compliant: `privateStateValues` is a required `integer` (not nullable), so return `0` instead of `null` in both the activated and not-activated branches.

- [#155](https://github.com/ascorbic/cirrus/pull/155) [`d1a7074`](https://github.com/ascorbic/cirrus/commit/d1a70748126870274980d76e230719e29f408290) Thanks [@a-lavis](https://github.com/a-lavis)! - Fix two OAuth token refresh bugs that prevented spec-compliant clients (e.g. tangled.org via indigo) from refreshing their session after the access token expired.
  - Track access and refresh expiry separately on `TokenData` (`accessExpiresAt` / `refreshExpiresAt`) instead of a single `expiresAt`. `cleanup()` now prunes by `refreshExpiresAt`, so a row isn't deleted while its refresh token is still valid. The PDS SQLite store migrates legacy `oauth_tokens` rows in place, deriving `refresh_expires_at` as `MAX(expires_at, issued_at + REFRESH_TOKEN_TTL)`.
  - The PDS auth middleware now sends `WWW-Authenticate: DPoP error="invalid_token"` on 401 responses for invalid/expired OAuth access tokens, as required by the atproto XRPC spec. Clients that gate refresh on this header (indigo, and others) will now refresh automatically instead of staying logged-in-but-broken until the user signs out.

- Updated dependencies [[`ec935b1`](https://github.com/ascorbic/cirrus/commit/ec935b16b7f44b22ff325781e0c88ccc3d07e599), [`d1a7074`](https://github.com/ascorbic/cirrus/commit/d1a70748126870274980d76e230719e29f408290)]:
  - @getcirrus/oauth-provider@0.4.0

## 0.13.0

### Minor Changes

- [#147](https://github.com/ascorbic/cirrus/pull/147) [`2f06391`](https://github.com/ascorbic/cirrus/commit/2f06391127683f0212ac7a837a90946875a91bd5) Thanks [@ascorbic](https://github.com/ascorbic)! - Add app password support for AT Protocol client authentication. Implements `com.atproto.server.createAppPassword`, `listAppPasswords`, `revokeAppPassword`, and login via app passwords. Includes CLI commands for creating, listing, and revoking app passwords.

## 0.12.0

### Minor Changes

- [#140](https://github.com/ascorbic/cirrus/pull/140) [`6cc3cfc`](https://github.com/ascorbic/cirrus/commit/6cc3cfcedfcde0faa99a1374daeb5534e4e082a1) Thanks [@ascorbic](https://github.com/ascorbic)! - Improve CLI dashboard design

## 0.11.0

### Minor Changes

- [#137](https://github.com/ascorbic/cirrus/pull/137) [`90e9771`](https://github.com/ascorbic/cirrus/commit/90e9771f61ad74b276d10cda7b9a900f72691605) Thanks [@ascorbic](https://github.com/ascorbic)! - Add option to auto-generate a password during `pds init` and `pds secret password`, with clipboard copy support

- [#136](https://github.com/ascorbic/cirrus/pull/136) [`287c971`](https://github.com/ascorbic/cirrus/commit/287c971cb82ee41519c51f2528641093bd304172) Thanks [@ascorbic](https://github.com/ascorbic)! - Add live terminal dashboard for PDS monitoring via `pds dashboard`. Shows repository stats, federation sync status, firehose subscribers with IPs, real-time event log, and notifications. Also adds a web dashboard at `/status`.

## 0.10.6

### Patch Changes

- [#134](https://github.com/ascorbic/cirrus/pull/134) [`127f3db`](https://github.com/ascorbic/cirrus/commit/127f3db0f23e2d13ef71a23de6f85a26b1b83c94) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix OAuth client metadata caching to avoid redundant network requests

  Client metadata was re-fetched from the network on every OAuth request instead of using the cache, adding latency to token exchanges and making auth fragile when client metadata endpoints are slow or unavailable.

- Updated dependencies [[`e76f1e4`](https://github.com/ascorbic/cirrus/commit/e76f1e40c3a251c778d257b1715b3d56a3ced5a4), [`127f3db`](https://github.com/ascorbic/cirrus/commit/127f3db0f23e2d13ef71a23de6f85a26b1b83c94)]:
  - @getcirrus/oauth-provider@0.3.2

## 0.10.5

### Patch Changes

- [#131](https://github.com/ascorbic/cirrus/pull/131) [`ab73a2d`](https://github.com/ascorbic/cirrus/commit/ab73a2d71451fa2c6fa17038a789c44ec8520649) Thanks [@ascorbic](https://github.com/ascorbic)! - Stream getRepo response to fix OOM on large repos

- [#129](https://github.com/ascorbic/cirrus/pull/129) [`764fef3`](https://github.com/ascorbic/cirrus/commit/764fef37bbd0a65ce8eeadf5cf30b3f812071466) Thanks [@ascorbic](https://github.com/ascorbic)! - Include "cirrus" in the version string returned from the health check endpoint.

## 0.10.4

### Patch Changes

- [#127](https://github.com/ascorbic/cirrus/pull/127) [`e09a661`](https://github.com/ascorbic/cirrus/commit/e09a6614079abed82a57226dddf675f6c289bc1e) Thanks [@ascorbic](https://github.com/ascorbic)! - Cache collection names in SQLite for describeRepo performance

## 0.10.3

### Patch Changes

- [#123](https://github.com/ascorbic/cirrus/pull/123) [`4e3d4e9`](https://github.com/ascorbic/cirrus/commit/4e3d4e9e3aa1ae7783ab8536e9ab74c6fa87b6eb) Thanks [@ascorbic](https://github.com/ascorbic)! - Rename getAccountStatus endpoint to checkAccountStatus to match AT Protocol lexicon

- [#126](https://github.com/ascorbic/cirrus/pull/126) [`99272ea`](https://github.com/ascorbic/cirrus/commit/99272ea4f6e2d1a338bb5818da8927b743263c4f) Thanks [@ascorbic](https://github.com/ascorbic)! - Add updateEmail endpoint and include email in session responses

  Store email in DO storage and return it from getSession, createSession, and refreshSession responses. Fixes deck.blue and official app complaints about missing email field.

## 0.10.2

### Patch Changes

- [#120](https://github.com/ascorbic/cirrus/pull/120) [`82301c5`](https://github.com/ascorbic/cirrus/commit/82301c5ca70ee2fcc1f69900cf55b8fdbbf92bdc) Thanks [@ascorbic](https://github.com/ascorbic)! - Skip OAuth authorization for messaging platform link preview bots

  Messaging platforms (Telegram, Slack, Discord, Twitter/X, Facebook/iMessage) pre-fetch URLs shared in DMs and channels. When an OAuth authorization link with a one-time PAR request URI is shared, the preview bot consumes it before the user can open it. The authorize endpoint now detects these specific bots by User-Agent and returns a minimal HTML page with appropriate meta tags instead of processing the OAuth request.

  Only known messaging platform bots are matched — generic crawlers and spiders are not excluded, since an unknown bot hitting an OAuth URL should still consume the token.

- [#116](https://github.com/ascorbic/cirrus/pull/116) [`a06516a`](https://github.com/ascorbic/cirrus/commit/a06516a8898b5be50ea4de0f68b5360140d4d990) Thanks [@ascorbic](https://github.com/ascorbic)! - Detect content type of blobs

- [#119](https://github.com/ascorbic/cirrus/pull/119) [`92a2b39`](https://github.com/ascorbic/cirrus/commit/92a2b39cdf53df0d4478e83ff679995e3fabc78c) Thanks [@ascorbic](https://github.com/ascorbic)! - Normalize JSON blob references for correct dag-cbor encoding

  Incoming API records contain blob references with nested `$link` objects
  (for example, `{ "$type": "blob", "ref": { "$link": "bafk..." } }`). These
  must be converted to actual CID instances before CBOR encoding, otherwise
  the blob ref's `ref` field gets encoded as a map instead of a proper CID tag.
  This causes incorrect block hashes, which can lead to blob resolution failures
  on the Bluesky network.

  Uses `jsonToLex` from `@atproto/lex-json` to convert `$link` → CID and
  `$bytes` → Uint8Array on all record write paths (createRecord, putRecord,
  applyWrites).

## 0.10.1

### Patch Changes

- Updated dependencies [[`982e067`](https://github.com/ascorbic/cirrus/commit/982e067aec5b7a3ec0f30bdf14146612fabca186)]:
  - @getcirrus/oauth-provider@0.3.1

## 0.10.0

### Minor Changes

- [#104](https://github.com/ascorbic/cirrus/pull/104) [`6e99cc6`](https://github.com/ascorbic/cirrus/commit/6e99cc64bebb83ec2c8ae78b33b774bcd7697a7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Add data placement support for Durable Objects
  - Added `DATA_LOCATION` environment variable for controlling DO placement
  - Supports `eu` jurisdiction (hard guarantee) and location hints (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`)
  - Default is `auto` (no location constraint, recommended for most users)
  - Exported `DataLocation` type from package

  These features use Cloudflare's Durable Object data location capabilities. The `eu` jurisdiction provides compliance guarantees that data never leaves the EU, while hints are best-effort suggestions for latency optimization.

  Warning: Do not change this setting after initial deployment. It only affects newly-created DOs and will not migrate existing data.

### Patch Changes

- [#102](https://github.com/ascorbic/cirrus/pull/102) [`39ff210`](https://github.com/ascorbic/cirrus/commit/39ff21073f284bfa8a7e50f0f2cf20402908646b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix SIGNING_KEY not being pushed to Cloudflare when re-running init after initially declining. Also default "Push secrets to Cloudflare now?" to yes and show clear deployment instructions when declining.

- [#108](https://github.com/ascorbic/cirrus/pull/108) [`3d5b264`](https://github.com/ascorbic/cirrus/commit/3d5b26453c037655f7998dfcd6f0d9499cc1b08c) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix automatic token refresh not triggering after access token expiry

  Fixes the authentication loss issue where Cirrus-hosted accounts would lose auth after ~2 hours, requiring users to switch accounts or reload the page to recover.

  **Root Cause:**
  The Bluesky client's `fetchHandler` specifically checks for HTTP 400 with error code `'ExpiredToken'` to trigger automatic token refresh. Cirrus was returning HTTP 401 with `'InvalidToken'`, which the client interpreted as "token is fundamentally broken" rather than "token expired, please refresh".

  **Fixes:**
  1. Return HTTP 400 with `'ExpiredToken'` for expired access tokens (matching official PDS)
  2. Added `TokenExpiredError` class to detect `jose.errors.JWTExpired` specifically
  3. Fixed JWT scope to use `'com.atproto.access'` (matching official PDS)
  4. Removed duplicate `jti` from refresh token payload
  5. Removed JWT `iss` claim to match official PDS
  6. Added `emailConfirmed` field to session responses

## 0.9.0

### Minor Changes

- [#99](https://github.com/ascorbic/cirrus/pull/99) [`1275523`](https://github.com/ascorbic/cirrus/commit/1275523097b6b8b754d7f3e8ce20cf7a7fbd1f7f) Thanks [@ascorbic](https://github.com/ascorbic)! - feat: implement com.atproto.sync.getRecord endpoint

  Add support for the `com.atproto.sync.getRecord` endpoint, which returns a CAR file containing the commit block and all MST blocks needed to prove the existence (or non-existence) of a record. This enables tools like pdsls to verify record signatures.

### Patch Changes

- [#101](https://github.com/ascorbic/cirrus/pull/101) [`f2f891b`](https://github.com/ascorbic/cirrus/commit/f2f891b0547f7349781a20c06183192278ae68f1) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix authentication loss by reducing access token lifetime to 15 minutes

  Reduces access token lifetime from 2 hours to 15 minutes to match the official Bluesky PDS implementation and AT Protocol OAuth specification (which recommends 1-5 minutes with a maximum of 1 hour).

  This fixes the periodic authentication loss issue where the Bluesky app and web interface would lose authentication and require account switching or page reload to recover. Short-lived tokens force regular refresh cycles, keeping sessions fresh and properly synchronized with the app's token management.

## 0.8.0

### Minor Changes

- [#93](https://github.com/ascorbic/cirrus/pull/93) [`34c84aa`](https://github.com/ascorbic/cirrus/commit/34c84aae2ff8472ea6589c8c35a665bb2b9c63ce) Thanks [@ascorbic](https://github.com/ascorbic)! - Add migrate-out token generation for account migration

  Adds `pds migrate-token` CLI command that generates stateless HMAC-based migration tokens for users wanting to migrate their account to another PDS. Tokens are valid for 15 minutes and require no database storage.

### Patch Changes

- [#95](https://github.com/ascorbic/cirrus/pull/95) [`11d1f70`](https://github.com/ascorbic/cirrus/commit/11d1f70f6f9b11d8632dad2733b229ceb8107a00) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix service JWT expiry for video uploads

  Extended the service JWT expiry from 60 seconds to 5 minutes. This fixes video upload failures where larger videos would take longer than 60 seconds to process on video.bsky.app, causing the callback to your PDS to fail with 401 due to the expired JWT.

  Also enables observability in the Cloudflare Worker template for better debugging.

## 0.7.0

### Minor Changes

- [#91](https://github.com/ascorbic/cirrus/pull/91) [`886785a`](https://github.com/ascorbic/cirrus/commit/886785af18362ed375d386f06f39e98a568530c9) Thanks [@ascorbic](https://github.com/ascorbic)! - Add `pds identity` command for seamless PLC migration

  When migrating from another PDS (like bsky.social), this new command handles the PLC directory update:
  - Requests a PLC operation signature from your source PDS via email token
  - Signs the operation with your new Cirrus signing key
  - Submits the signed operation to plc.directory

  This streamlines the migration flow – run `pds migrate`, then `pds identity`, then `pds activate`.

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
