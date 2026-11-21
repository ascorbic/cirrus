---
"@getcirrus/space-conformance": minor
---

Give one-sided checks a success-path control, so a host whose feature is broken no longer passes on refusals alone.

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
