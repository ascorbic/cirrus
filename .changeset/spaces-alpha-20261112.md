---
"@getcirrus/pds": minor
"@getcirrus/spaces": minor
"@getcirrus/oauth-provider": minor
---

Update atproto spaces to the 2026-11-17 alpha (`0.0.0-spaces-alpha-20261117141222`), which carries the 2026-11-12 protocol changes. This is a breaking alpha change: the space schema moves to version 3, so existing space data refuses to open until you run `pds spaces reset`, and apps and syncers built against the 2026-11-05 alpha need updating.

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
