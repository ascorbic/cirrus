---
"@getcirrus/pds": minor
"@getcirrus/spaces": minor
"@getcirrus/oauth-provider": patch
"create-pds": patch
---

Update atproto spaces to the 2026-11-05 alpha (`0.0.0-spaces-alpha-20261105160032`). This is a breaking alpha change: existing space data refuses to open until you run `pds spaces reset`, and apps built against the earlier alpha need updating.

- Space credentials are bound to a P-256 key and presented with the `Atproto-Space-Credential` scheme and an HTTP message signature, replacing DPoP. `getSpaceCredential` takes the key, delegation token and client attestation in its body, and public-read spaces issue credentials without a delegation token.
- Commits are no longer signed. Syncers verify space data with a MAC derived against a new `#atproto_kem` key. Run `pds spaces kem` to create it; on did:plc, `pds spaces kem --publish` adds it to your DID document. `pds spaces status` checks that it is published.
- `com.atproto.simplespace` is replaced by the personalspace, memberspace and managedspace policies, managed with `com.atproto.space.{create,update,delete,get}Space` and `com.atproto.memberspace.*`. Members can be given read or write access separately, and a space can publish its policy and member list to readers.
- `getRepo` serves a STAR archive, streamed rather than buffered.
- Writes are sequenced by space revision, and notifications to a space hosted elsewhere are retried for up to 24 hours.
- New: `clearRecords`, `removeWriter`, `importRepo`, `exportSpaceMeta` and `importSpaceMeta`. `pds spaces export` writes STAR archives that the new import endpoints accept.
- The DID document no longer has an `#atproto_space_host` service entry.

`@getcirrus/spaces` now bundles `@atproto/space` and its alpha dependencies, several of which have broken releases that package managers would otherwise install in their place.
