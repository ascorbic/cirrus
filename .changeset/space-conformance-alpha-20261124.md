---
"@getcirrus/space-conformance": minor
---

Port the conformance suite to the 2026-11-24 spaces alpha (`0.0.0-spaces-alpha-20261124235736`). In this alpha, space URIs are `at:space/{spaceDid}/{spaceType}/{skey}[/{authorDid}/{collection}/{rkey}]` instead of `at://{spaceDid}/space/…`.

- Every probe builds and parses only the new form. A credential's default audience is the first segment after `at:space/`, the space DID.
- Existing checks now require hosts to emit the new form:
  - `space.create-and-get` checks the `space` that `createSpace` returns.
  - `space.listspaces-filters` checks the `listSpaces` entries.
  - `writes.create-and-read` checks the record `uri` from `createRecord` and `getRecord`.
  - `credential.claims` and `delegation.token-claims` check the `sub` of credentials and delegation tokens.
  - `mac.commit-verifies` and `mac.record-verifies` check the `space` and `uri` covered by the commit and record MACs. These are now verified against the ref built from the skey, not one echoed back by the host.
- New check `request.legacy-space-uri-rejected`: a `space` param in the old `at://…/space/…` form gets `400 InvalidRequest` from `getRecord`, `getSpace` and `createRecord`. The same space's `at:space/` ref is served.
- New check `request.handle-space-authority-rejected`: a space ref that names its authority by handle (the operator's own, taken from its DID document) gets `400 InvalidRequest`. The DID ref is served.
- The changesets `spaces-syntax`, `pds-space-uri-migration` and `alpha-space-uris` can now be cited.
