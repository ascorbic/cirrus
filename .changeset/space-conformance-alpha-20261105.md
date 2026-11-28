---
"@getcirrus/space-conformance": minor
---

Port the conformance suite to the 2026-11-05 spaces alpha (`0.0.0-spaces-alpha-20261105160032`). The catalogue grows from 24 to 92 checks, and every method and declared error in the vendored lexicons is now covered by a `must` check, apart from the takedown, suspension and deactivation errors, which are exempted with a reason because no black-box harness can arrange them.

- Credentials are presented with the `Atproto-Space-Credential` scheme and an HTTP message signature by a P-256 key, and credentialed reads send `Atproto-Space-Want-Mac`. The DPoP helpers are gone; `createCredentialKey`, `spaceSigHeaders` and `encapsulate` replace them, all browser-safe.
- New checks cover the baseline policies, member management, credential issuance and refusals, signature and audience binding, MAC requests and verification, STAR archives, writer-set sequencing, notifications, revocation, and space and repo migration.
- Discovery checks resolve the target's DID by method and look for `#atproto_pds`, `#atproto` and a P-256 `#atproto_kem`, replacing the `#atproto_space_host` checks.
- `Target.plcDirectory` and `CheckContext.resolveDid` control DID resolution; the CLI takes `--plc`. `SyncerInbox` gains `respond()` so a harness can act as a managing app. `KeypairIdentityProvider` takes an async `didFor` and builds identity DID documents.
- The CLI's OAuth scope asks for `authority=*` on the probe space type, so refusals for spaces the user does not own reach the host's own checks.
- The coverage report lists exemptions and flags stale ones, and `space-conformance coverage` now exits non-zero on gaps.
