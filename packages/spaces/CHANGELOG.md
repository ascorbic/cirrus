# @getcirrus/spaces

## 0.2.0

### Minor Changes

- [#256](https://github.com/ascorbic/cirrus/pull/256) [`9ca9c2f`](https://github.com/ascorbic/cirrus/commit/9ca9c2f5824a19d31febf24d5f358dcddc88f224) Thanks [@ascorbic](https://github.com/ascorbic)! - Update atproto spaces to the 2026-11-05 alpha (`0.0.0-spaces-alpha-20261105160032`). This is a breaking alpha change: existing space data refuses to open until you run `pds spaces reset`, and apps built against the earlier alpha need updating.
  
  - Space credentials are bound to a P-256 key and presented with the `Atproto-Space-Credential` scheme and an HTTP message signature, replacing DPoP. `getSpaceCredential` takes the key, delegation token and client attestation in its body, and public-read spaces issue credentials without a delegation token.
  - Commits are no longer signed. Syncers verify space data with a MAC derived against a new `#atproto_kem` key. Run `pds spaces kem` to create it; on did:plc, `pds spaces kem --publish` adds it to your DID document. `pds spaces status` checks that it is published.
  - `com.atproto.simplespace` is replaced by the personalspace, memberspace and managedspace policies, managed with `com.atproto.space.{create,update,delete,get}Space` and `com.atproto.memberspace.*`. Members can be given read or write access separately, and a space can publish its policy and member list to readers.
  - `getRepo` serves a STAR archive, streamed rather than buffered.
  - Writes are sequenced by space revision, and notifications to a space hosted elsewhere are retried for up to 24 hours.
  - New: `clearRecords`, `removeWriter`, `importRepo`, `exportSpaceMeta` and `importSpaceMeta`. `pds spaces export` writes STAR archives that the new import endpoints accept.
  - The DID document no longer has an `#atproto_space_host` service entry.
  
  `@getcirrus/spaces` now bundles `@atproto/space` and its alpha dependencies, several of which have broken releases that package managers would otherwise install in their place.

- [#256](https://github.com/ascorbic/cirrus/pull/256) [`9ca9c2f`](https://github.com/ascorbic/cirrus/commit/9ca9c2f5824a19d31febf24d5f358dcddc88f224) Thanks [@ascorbic](https://github.com/ascorbic)! - Update atproto spaces to the 2026-11-17 alpha (`0.0.0-spaces-alpha-20261117141222`), which carries the 2026-11-12 protocol changes. This is a breaking alpha change: the space schema moves to version 3, so existing space data refuses to open until you run `pds spaces reset`, and apps and syncers built against the 2026-11-05 alpha need updating.
  
  To upgrade a PDS with spaces enabled:
  
  1. Deploy, then run `pds spaces reset`. Space endpoints answer 503 until you do.
  2. If you haven't already, create the `#atproto_kem` key with `pds spaces kem`. Without it, every credentialed read that needs a MAC (`getRecord`, `getLatestCommit`, `getRepo`, `listRepoOps`) fails with `503 KemKeyUnavailable`, so other apps and syncers can't read your spaces. The command stores the private key as the `SPACES_KEM_KEY` secret and the public key as `SPACES_KEM_KEY_PUBLIC`; then redeploy.
  3. On did:plc, publish the key in your DID document with `pds spaces kem --publish`. Your PDS signs the PLC operation, so its signing key must be one of your DID's rotation keys: if it isn't, run `pds rotation-keys` first. On did:web, the redeploy publishes it.
  4. Run `pds spaces status` to check that the key your PDS holds is the one your DID document publishes.
  5. A managed space's managing app must now be named as `did#service`.
  
  - Renamed methods: `getSpaceCredential` is now `authorizeSpaceSync` (taking `credentialKey`), `listRepos` is `listWriters`, `notifyWrite` is `notifyRepoUpdate`, `notifyCredentialRevoked` is `notifyCredentialsRevoked` and the managing app's `checkUserAccess` is `checkAccess`. `putMember` / `removeMember` are replaced by batched `putMembers` / `removeMembers` (up to 100 at a time, in one commit).
  - Syncers register for notifications by passing a webhook endpoint and token to `authorizeSpaceSync`, which the space host confirms with the syncer's `confirmRegistration` before issuing. Updates go to its `notifySpaceUpdate`; a lapsed registration gets one `registrationExpired` notice, and deleting a space tells every registered syncer, retried for up to 72 hours. `registerNotify`, `unregisterNotify` and `notifySpaceDeleted` are gone.
  - Removing a writer is sequenced and announced, and `listWriters` lists removals.
  - MACs are HTTP message signatures, requested with `Accept-Signature` and covering an `Atproto-Space-Commit` or `Atproto-Space-Record` header. STAR archives use the `application/vnd.dasl.star` media type.
  - A managed space's `managingApp` must name a service (`did#service`). If the app fails, the request fails with `UpstreamFailure` rather than being refused. Under `publicWrite`, a member denied write stays excluded.
  - `listRepoOps` returns the commit on every page; `listSpaces` returns each space's repo revision, digest and space revision.
  - Error codes renamed: `NotSpaceOwner` → `NotAuthorized`, `UserNotAuthorized` → `AccountNotAuthorized`, `BadSpaceMac` → `InvalidSpaceMac`, `MalformedCursor` → `InvalidCursor`.
  - oauth-provider: space permissions carry `spaceType` rather than `type`, space declarations use `title`, and a new `allowsSpace(permissions, check)` helper matches requests against granted scopes.

### Patch Changes

- [#255](https://github.com/ascorbic/cirrus/pull/255) [`de476f5`](https://github.com/ascorbic/cirrus/commit/de476f57ba1fb936c6480a8fc278b6c7fc250cab) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix fresh installs failing with `"@atproto/lex-data@workspace:*" is in the dependencies but no package named "@atproto/lex-data" is present in the workspace` (or `Unsupported URL Type "workspace:"` under npm). This affected new projects created with `create-pds`, as well as any project installing these packages without an existing lockfile.

- [#260](https://github.com/ascorbic/cirrus/pull/260) [`a8c4a9f`](https://github.com/ascorbic/cirrus/commit/a8c4a9f4bf22a86609b51d425cf19c056fb27d8a) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix client attestation verification on Workers. The client metadata and JWKS fetches used `redirect: "error"`, which workerd refuses, so every attestation failed and a memberspace with `allowedApps` refused every app. They now use `redirect: "manual"` and still reject redirects.

- [#260](https://github.com/ascorbic/cirrus/pull/260) [`a8c4a9f`](https://github.com/ascorbic/cirrus/commit/a8c4a9f4bf22a86609b51d425cf19c056fb27d8a) Thanks [@ascorbic](https://github.com/ascorbic)! - The managing app's `checkAccess` call and `notifyRepoUpdate` to a space hosted elsewhere no longer follow redirects, as registration confirmation and attestation fetches already didn't: a 3xx is a failure. A redirected `checkAccess` answers `UpstreamFailure`, and a redirected `notifyRepoUpdate` is dropped rather than re-sent with its service auth to another host.

## 0.1.0

### Minor Changes

- [#219](https://github.com/ascorbic/cirrus/pull/219) [`5762e22`](https://github.com/ascorbic/cirrus/commit/5762e22a9ece71a83eb4b3d67ae5a773c637ee7d) Thanks [@ascorbic](https://github.com/ascorbic)! - First release of `@getcirrus/spaces`: the atproto spaces engine (alpha) for Cloudflare Workers. Provides the per-space and index Durable Objects, permissioned repo storage with LtHash commits and oplog sync, space credential / delegation / DPoP / client-attestation verification, simplespace policies, and the Hono route factory for `com.atproto.space.*` and `com.atproto.simplespace.*`, all behind the host PDS's `SPACES_ENABLED` flag.
