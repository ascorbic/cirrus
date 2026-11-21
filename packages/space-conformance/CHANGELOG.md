# @getcirrus/space-conformance

## 0.1.0

### Minor Changes

- [#256](https://github.com/ascorbic/cirrus/pull/256) [`9ca9c2f`](https://github.com/ascorbic/cirrus/commit/9ca9c2f5824a19d31febf24d5f358dcddc88f224) Thanks [@ascorbic](https://github.com/ascorbic)! - Port the conformance suite to the 2026-11-05 spaces alpha (`0.0.0-spaces-alpha-20261105160032`). The catalogue grows from 24 to 92 checks, and every method and declared error in the vendored lexicons is now covered by a `must` check, apart from the takedown, suspension and deactivation errors, which are exempted with a reason because no black-box harness can arrange them.
  
  - Credentials are presented with the `Atproto-Space-Credential` scheme and an HTTP message signature by a P-256 key, and credentialed reads send `Atproto-Space-Want-Mac`. The DPoP helpers are gone; `createCredentialKey`, `spaceSigHeaders` and `encapsulate` replace them, all browser-safe.
  - New checks cover the baseline policies, member management, credential issuance and refusals, signature and audience binding, MAC requests and verification, STAR archives, writer-set sequencing, notifications, revocation, and space and repo migration.
  - Discovery checks resolve the target's DID by method and look for `#atproto_pds`, `#atproto` and a P-256 `#atproto_kem`, replacing the `#atproto_space_host` checks.
  - `Target.plcDirectory` and `CheckContext.resolveDid` control DID resolution; the CLI takes `--plc`. `SyncerInbox` gains `respond()` so a harness can act as a managing app. `KeypairIdentityProvider` takes an async `didFor` and builds identity DID documents.
  - The CLI's OAuth scope asks for `authority=*` on the probe space type, so refusals for spaces the user does not own reach the host's own checks.
  - The coverage report lists exemptions and flags stale ones, and `space-conformance coverage` now exits non-zero on gaps.

- [#256](https://github.com/ascorbic/cirrus/pull/256) [`9ca9c2f`](https://github.com/ascorbic/cirrus/commit/9ca9c2f5824a19d31febf24d5f358dcddc88f224) Thanks [@ascorbic](https://github.com/ascorbic)! - Port the conformance suite to the 2026-11-12 spaces protocol, pinned to the 2026-11-17 alpha (`0.0.0-spaces-alpha-20261117141222`).
  
  - Credentials come from `authorizeSpaceSync` (with `credentialKey`), and the writer set from `listWriters`, whose typed `repoWrite` / `repoRemoved` entries the checks now read. Member checks use the batched `putMembers` / `removeMembers`, and the managing-app checks use `checkAccess`, including the new tokenless call without a `repo`.
  - MAC requests are `Accept-Signature` headers keyed by an HPKE-exported secret, and the full checks verify the MAC signatures that come back. Credential signatures are checked to be found by tag under any label, with `keyid`, `alg`, component and duplicate-signature refusals.
  - Notification registration moves into `authorizeSpaceSync`'s `notify`. The `syncer-inbox` capability is now a webhook endpoint that answers `confirmRegistration` and receives `notifySpaceUpdate`. `createSyncerInbox()` provides one as a fetch-style handler.
  - New checks cover `RegistrationNotConfirmed`, the `spaceRev` returned on authorisation, announced writer removals, `listRepoOps` commits on every page, the STAR content type, `InvalidRepoFile`, `RepoMismatch` and `InvalidSpaceMeta`. A slow check covers `registrationExpired`.
  - Proposal 0016 citations are checked against its section anchors. The read methods' `SpaceNotFound` and every `InvalidCursor` are exempted from coverage with reasons, since nothing in the spec defines them.
  - The probe space type declaration uses `title` in place of `name`.
  - `request.garbage-cursor-rejected` filters its `listSpaces` call to the probe type, so it runs under an OAuth session scoped to that type instead of failing with `InsufficientScope`.

- [#230](https://github.com/ascorbic/cirrus/pull/230) [`2261832`](https://github.com/ascorbic/cirrus/commit/2261832c3f158e4422b5079ed159d7e703a2bde4) Thanks [@ascorbic](https://github.com/ascorbic)! - First release of `@getcirrus/space-conformance`: a black-box conformance suite for atproto spaces implementations. This release carries the core check model (tiered MUST/SHOULD/INFO checks with machine-readable citations), the capability-aware catalog runner with honest skip reporting, the vendored spaces lexicons, and the coverage generator that derives required checks from every lexicon method and declared error name.

- [#260](https://github.com/ascorbic/cirrus/pull/260) [`a8c4a9f`](https://github.com/ascorbic/cirrus/commit/a8c4a9f4bf22a86609b51d425cf19c056fb27d8a) Thanks [@ascorbic](https://github.com/ascorbic)! - Give one-sided checks a success-path control, so a host whose feature is broken no longer passes on refusals alone.
  
  - `createSyncerInbox()` now also plays an OAuth client. It serves `GET {endpoint}/client-metadata.json` (client_id is that URL, `jwks` holds one ES256 key), and `inbox.attest(aud)` mints client attestations signed by that key. `SyncerInbox` gains `clientId` and `attest()`. A harness that routes the inbox endpoint to `handle` needs no change, as long as GETs reach it too.
  - New checks `credential.valid-attestation-issues` and `credential.valid-attestation-unlisted-refused`, both gated on `syncer-inbox`. The first checks that a verifiable attestation from an app in `allowedApps` obtains a credential. The second checks that the same attestation is refused with `AppNotAuthorized` where the app is not listed. When a syncer inbox is available, the attestation refusal checks and `credential.allowed-apps-gate` first make sure a valid attestation issues. Without one they say in their detail that the success path was not checked. Checks can now declare such optional capabilities as `uses`.
  - `credential.unconfirmed-registration-refused` now first checks, when a syncer inbox is available, that a registration the inbox confirms issues a credential. It also checks that a token the inbox never issued is refused. Without an inbox it says that the success path was not checked. `notify.renewal-not-reconfirmed` requires the first registration to have been confirmed.
  - `managedspace.unreachable-app-fails-closed` and `-upstream-failure` now need `syncer-inbox`. Each first checks that a managing app answering `read: true` issues a credential, then requires a refusal both from an unresolvable app and from one that answers with an error.
  - Stricter answers:
    - `request.invalid-space-uri-rejected` is sent as the operator and requires a 400 with an XRPC error, so it now needs `operator`.
    - `revocation.non-authority-refused` requires 401/403.
    - `space.owner-state-not-by-credential`, `credential.cross-space-refused` and `writes.published-collections-refused` require a 4xx rather than anything but 200.
    - `managedspace.bare-did-rejected` requires `InvalidRequest` and first checks that a `did#serviceId` is accepted.
  - More success controls:
    - `writes.applywrites-update-missing` first updates an existing record.
    - `blobs.space-blob-not-public` first checks that a blob referenced by a public record is served by `sync.getBlob`.
    - New check `policy.personalspace-owner-admitted` (needs `pds-delegation`) checks that a personalspace issues its authority a credential.
  - Operator-tier details now say that MACs are checked for presence only, and that `mac.*-verifies` does the verifying.

### Patch Changes

- [#255](https://github.com/ascorbic/cirrus/pull/255) [`de476f5`](https://github.com/ascorbic/cirrus/commit/de476f57ba1fb936c6480a8fc278b6c7fc250cab) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix fresh installs failing with `"@atproto/lex-data@workspace:*" is in the dependencies but no package named "@atproto/lex-data" is present in the workspace` (or `Unsupported URL Type "workspace:"` under npm). This affected new projects created with `create-pds`, as well as any project installing these packages without an existing lockfile.

- [#238](https://github.com/ascorbic/cirrus/pull/238) [`a55ac49`](https://github.com/ascorbic/cirrus/commit/a55ac492b556b4b294b28818a4eb3d0ff3664344) Thanks [@ascorbic](https://github.com/ascorbic)! - Probe spaces now use published, resolvable lexicons (`earth.cirrus.check.space` / `.note` / `.withblob`) instead of the unpublished `app.bsky.group` type and unresolvable `test.conformance.*` collections, so the suite works against implementations that resolve lexicons dynamically and validate strictly — not only against lenient targets.
