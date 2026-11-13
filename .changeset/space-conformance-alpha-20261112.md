---
"@getcirrus/space-conformance": minor
---

Port the conformance suite to the 2026-11-12 spaces alpha (`0.0.0-spaces-alpha-20261112204144`).

- Credentials come from `authorizeSpaceSync` (with `credentialKey`), and the writer set from `listWriters`, whose typed `repoWrite` / `repoRemoved` entries the checks now read. Member checks use the batched `putMembers` / `removeMembers`, and the managing-app checks use `checkAccess`, including the new tokenless call without a `repo`.
- MAC requests are `Accept-Signature` headers keyed by an HPKE-exported secret, and the full checks verify the MAC signatures that come back. Credential signatures are checked to be found by tag under any label, with `keyid`, `alg`, component and duplicate-signature refusals.
- Notification registration moves into `authorizeSpaceSync`'s `notify`. The `syncer-inbox` capability is now a webhook endpoint that answers `confirmRegistration` and receives `notifySpaceUpdate`. `createSyncerInbox()` provides one as a fetch-style handler.
- New checks cover `RegistrationNotConfirmed`, the `spaceRev` returned on authorisation, announced writer removals, `listRepoOps` commits on every page, the STAR content type, `InvalidRepoFile`, `RepoMismatch` and `InvalidSpaceMeta`. A slow check covers `registrationExpired`.
- Proposal 0016 citations are checked against its section anchors. The read methods' `SpaceNotFound` and every `InvalidCursor` are exempted from coverage with reasons, since nothing in the spec defines them.
- The probe space type declaration uses `title` in place of `name`.
