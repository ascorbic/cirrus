# Atproto Spaces — Implementation Status

Spec: [spaces-spec.md](./spaces-spec.md). Everything is alpha, behind the
`SPACES_ENABLED` wrangler var.

## Implemented (2026-08-28)

Delivered as a stacked PR chain, bottom to top:

1. **Blob staging** (`spaces/blob-staging`) — public-path change, ships
   regardless of the flag. Uploads land at `${did}/staged/${cid}`; a record
   write promotes referenced blobs to `${did}/${cid}` before the DO commit.
   Migration uploads promote immediately (`rpcTrackBlob` reports whether
   the CID is referenced). `sync.listBlobs` uses a delimiter so nested
   namespaces never leak. `staged/` expiry is an R2 lifecycle rule
   (documented in the wrangler template — there is no wrangler.jsonc way to
   declare it).
2. **OAuth scopes** (`spaces/oauth-scopes`) — `space` granular resource
   from `@atproto/oauth-scopes@alpha` (pinned exact, Renovate-excluded),
   `spacesEnabled` provider flag, `authority=self` resolution and default
   collections at grant time, consent-screen space names with wildcard
   warnings.
3. **Engine** (`spaces/engine`) — `@getcirrus/spaces`: SpaceDurableObject
   (records, oplog + compaction, LtHash state, members, writers, notify
   queue with alarm delivery, replay table, schema-version refusal) and
   SpaceIndexDurableObject (pending/active/deleted lifecycle). Host
   identity via abstract `getHostConfig()` — never `env.DID` (S9).
4. **Protocol** (`spaces/protocol`) — route factory for all
   `com.atproto.space.*` / `com.atproto.simplespace.*` endpoints;
   credential/delegation/DPoP/attestation verification; policies
   (public, member-list, managing-app); Worker-side commit signing with
   fresh ikm; CAR export verified against `@atproto/space`'s consumer.
5. **PDS integration** (`spaces/pds`) — mounts behind the flag; host
   adapter (DID-doc key resolution with forced refresh, service endpoint
   resolution, foreign service-JWT verification, session auth);
   `getDelegationToken`, `listSpaces`; `#atproto_space_host` DID doc
   entry; app-password exclusion via the `apf` session claim; wrangler v2
   migration (additive, ships everywhere).
6. **Ops** (`spaces/ops`) — `pds spaces list|status|create|delete|members|
   export|reset`; dashboard Spaces panel;
   `gg.mk.experimental.getSpacesStatus` / `spacesReset` admin endpoints
   (mounted whenever the bindings exist, so reset works with the flag off
   or the schema outdated).

User stories S1–S9 all have automated coverage (54 engine/protocol tests,
8 PDS integration tests).

## Alpha 20261105160032 (2026-11-09)

Moved from the 0818 alpha to `0.0.0-spaces-alpha-20261105160032`, cut from
`permissioned-data-alpha@704b9e2`, following the sync process below. Five
upstream builds landed in between and the protocol changed substantially:

- **Credentials**: DPoP replaced by HTTP message signatures. Credentials
  bind a P-256 did:key (`cnf.kid`), are presented as
  `Authorization: Atproto-Space-Credential <jwt>` with an
  `Atproto-Space-Audience` header (the DID being called: always the
  operator here), and live 600s. `getSpaceCredential` takes
  `credentialKid` / `delegationToken` / `clientAttestation` in the body;
  public-read spaces issue without a delegation token; refused users get
  `SpaceNotFound`. Revocations arrive via `notifyCredentialRevoked` and
  are kept per space DO.
- **Discovery**: `#atproto_space` / `#atproto_space_host` dropped. The
  authority's `#atproto_pds` is the space host; `#atproto` signs tokens.
- **Commits and MACs**: commits are `{ver, repo, space, rev, data}` with
  no signature. Credentialed reads returning a commit or record need
  `Atproto-Space-Want-Mac`; the host derives a secret against its
  `#atproto_kem` P-256 key (`SPACES_KEM_KEY` secret,
  `SPACES_KEM_KEY_PUBLIC` var, `pds spaces kem`) and answers
  `Atproto-Space-Mac`.
- **getRepo** streams STAR (`atproto-space-repo`) in record-path byte
  order, fenced against concurrent writes by rev. This also retires the
  "getRepo buffers the whole repo" open question.
- **Policies**: simplespace replaced by personalspace / memberspace /
  managedspace (`com.atproto.space.{create,update,delete,get}Space`,
  `com.atproto.memberspace.*`), stored as the normalised lexicon object.
  Optional published `com.atproto.space.policy` / `memberspace.member`
  records in the authority's repo, written atomically by the DO.
- **Sequencing**: writers carry `spaceRev`; `listRepos` pages by it;
  forwarded `notifyWrite`s add `spaceRev` / `prevSpaceRev`; `FutureRev`
  beyond 5 minutes of skew. The writer role now retries its notifyWrite
  to a foreign authority for 24h, coalesced in the DO queue.
- **Migration**: `importRepo`, `exportSpaceMeta`, `importSpaceMeta`;
  `clearRecords`; `removeWriter`. Imported records' blobs are registered
  as pending in the index DO and promoted by `repo.uploadBlob`.
- **Schema version 2**: existing space DOs refuse until
  `pds spaces reset`, per the alpha policy.

### Conformance at 1105

The suite grew from 24 to 92 checks (87 must, 4 should, 1 info), with
coverage requiring zero gaps against the vendored lexicons (the only
exemptions are the admin-only `RepoTakendown` / `RepoSuspended` /
`RepoDeactivated` errors). Results on 2026-11-09:

- **Reference (matrix):** 89 pass, 3 pinned divergences, nothing
  skipped: `writes.delete-in-missing-space` (its deleteRecord answers 200
  before checking the space), `space.reads-after-delete-not-found` (reads
  of a deleted space don't answer `SpaceNotFound`) and
  `credential.garbage-attestation-refused` (a malformed attestation is a
  500). See the matrix README.
- **Cirrus space routes (in-process):** every runnable must and should
  check passes, the three above included. Only the `pds-blobs` and
  `pds-delegation` checks skip; the PDS run covers them.
- Running it found four Cirrus bugs, all fixed: getBlob's order of
  checks, `NotSpaceOwner` on foreign spaces, `listSpaces` living outside
  the engine, and the PDS fetching its own DID document to resolve its own
  `#atproto_pds`.

### Packaging: the alpha is bundled

`@atproto/space@1105` depends on the alpha `lex-cbor` / `lex-data` /
`star`, each of which has a release that outranks
`^0.0.0-spaces-alpha-*` and is broken (bare `0.0.0` with `workspace:*`
deps; `star@0.0.0-stage` is a corrupt tarball). Verified with scratch
installs: exact sibling pins (the #255 fix) no longer rescue npm once a
stable `lex-data` sits at the root, as it does under `@getcirrus/pds`. So
`@getcirrus/spaces` and `@getcirrus/space-conformance` keep every alpha
`@atproto` package in devDependencies and tsdown bundles them
(`platform: "browser"` so the browser builds are picked, not ones reaching
for `node:crypto`). `@getcirrus/pds` no longer depends on `@atproto/space`
at runtime. Public types are structural (`SpaceSigningKeypair`,
`SpaceCommit`) so no `.d.ts` references an `@atproto` package. Check after
each bump: `grep -o 'from "[^"]*"' packages/spaces/dist/*.js packages/spaces/dist/*.d.ts`.

## Alpha 20261112204144 (2026-11-13)

Moved to `0.0.0-spaces-alpha-20261112204144`, cut from
`permissioned-data-alpha@b27a037c7`, a week after 1105. Smaller in scope but
it renames most of the sync surface:

- **Renames**: `getSpaceCredential` → `authorizeSpaceSync` (body takes
  `credentialKey` and optional `notify`, output `{credential, spaceRev?}`),
  `listRepos` → `listWriters` (typed `defs#repoWrite` / `defs#repoRemoved`
  entries), `notifyWrite` → `notifyRepoUpdate`, `notifyCredentialRevoked`
  → `notifyCredentialsRevoked`, `checkUserAccess` → `checkAccess`
  (`{read, write}`, no `access` param; called with no `repo` for anonymous
  requests), `putMember` / `removeMember` → `putMembers` / `removeMembers`
  (≤100, one commit, last entry wins, non-members ignored).
- **Registration**: `registerNotify` / `unregisterNotify` /
  `notifySpaceDeleted` are gone. A syncer passes `notify: {endpoint,
  token}` to `authorizeSpaceSync`; a new registration is confirmed by
  calling the syncer's `confirmRegistration` (token + challenge in the body,
  no service auth, no redirects, 10s timeout) before the credential is
  issued, else `RegistrationNotConfirmed`. The registration is keyed
  `(endpoint, token)` and its expiry renewed to the credential's `exp`.
  Refusal withdraws it, except on `UpstreamFailure`. Updates go to the
  syncer's `notifySpaceUpdate` with the token in the body. The first update
  after a lapse becomes a one-off `registrationExpired` notice instead;
  `spaceDeleted` goes to every registration, lapsed or not. Those two
  notices retry at 1m/10m/1h/6h/12h (jittered) for 72h, and a rejected
  expiry notice unregisters the syncer.
- **Writer set**: `removeWriter` (now `repo`) sequences a removal and
  announces it; removed writers stay in `listWriters` and are excluded from
  `exportSpaceMeta`. Sequencing and fan-out queueing happen in one DO
  transaction.
- **MACs** are RFC 9421 signatures: `Accept-Signature` with profile tags
  `atproto-space-commit` / `atproto-space-record`, answered by
  `Atproto-Space-Commit` / `Atproto-Space-Record` plus `Signature-Input` /
  `Signature`, keyed by HPKE secret export. Routes set
  `Vary: Accept-Signature` and expose the headers; the PDS CORS list
  matches.
- **Errors**: `NotSpaceOwner` → `NotAuthorized` (400),
  `UserNotAuthorized` → `AccountNotAuthorized`, `BadSpaceMac` →
  `InvalidSpaceMac`, `MalformedCursor` → `InvalidCursor`. New
  `InvalidRepoFile`, `RepoMismatch`, `InvalidSpaceMeta`,
  `RegistrationNotConfirmed`, `UpstreamFailure` (502, managing app failed:
  never treated as a denial).
- **Smaller**: STAR is `application/vnd.dasl.star` both ways; space meta
  writer entries use `repoRev`; `managingApp` must be `did#serviceId`;
  `allowedApps` entries must be URIs; `publicWrite` no longer admits a
  member with `write: false`; `createSpace` / `getSpace` output `space`;
  `listSpaces` takes `spaceDid` and returns `{space, repoRev?, data?,
  spaceRev?}`; `listRepoOps` returns the commit on every page, a cursor only
  on a full page, `RepoNotFound` for a never-written repo; `listRecords`
  drops `reverse`, `listBlobs` drops `since`.
- **oauth-scopes**: `SpacePermission#type` → `spaceType`, `allowsSpace`
  takes `(target, op)`, the named scope param is `spaceType`, declarations
  use `title`. oauth-provider exports its own `allowsSpace(permissions,
  check)` so the PDS keeps the flat match shape.
- **Schema version 3** (writer `removed_at`, re-keyed registrations,
  queue `policy` / `auth`): `pds spaces reset` again.

Four more upstream packages gained releases outranking the alpha range
(`lex-rpc`, `oauth-resolver`, `lex-password-session`, `bsync`); all are
overridden in `pnpm-workspace.yaml`.

SSRF: the reference wraps outbound webhook calls in `safeFetch`. Cirrus
requires `https` endpoints and refuses redirects; Workers can't reach
private address space, so that covers the same ground.

### Conformance at 1112

106 checks (95 must, 10 should, 1 info); coverage 91 of 127 lexicon
requirements, zero gaps, 36 exempt. Results on 2026-11-13:

- **Reference (matrix):** 103 pass, 2 pinned divergences
  (`writes.delete-in-missing-space`, `credential.garbage-attestation-refused`,
  both unchanged since 1105), and the slow `notify.registration-expired`
  skipped in CI. Run by hand, the reference passes it too.
  `space.reads-after-delete-not-found` is gone: 1112 dropped its citation.
- **Cirrus space routes (in-process):** every runnable must and should
  check passes. Skips: the `pds-blobs` / `pds-delegation` checks (the PDS
  run covers them) and the slow check, which passes when run by hand
  (607s, waiting out the credential).
- **Cirrus PDS (integrated worker):** passes, self-flow credential
  round-trip included.
- Found one Cirrus bug, fixed: `listMembers` accepted a cursor that isn't
  a DID instead of answering `InvalidCursor`.
- The syncer inbox is now `createSyncerInbox()` from the suite: it answers
  `confirmRegistration` only for tokens it issued for that space, so
  Cirrus's runner no longer hand-rolls one.
- The probe space declaration (`earth.cirrus.check.space`) uses `title`
  and needs republishing (loop in `probe-lexicons/README.md`).

## Alpha sync process

Upstream cuts a build from `permissioned-data-alpha` most Thursdays. To
move to a new one (the update loop from the space-conformance spec, #228):

1. **Find the build and its commit.** `npm view @atproto/space dist-tags`
   for the version; the source commit is the last one on
   `permissioned-data-alpha` before the build's timestamp (UTC). Read the
   `.changeset/*.md` files on the branch: they describe every protocol
   change.
2. **Re-vendor lexicons.** Check out that commit and run
   `pnpm --filter @getcirrus/space-conformance vendor-lexicons <absolute path to checkout>`.
   The lexicon diff, through check citations, names the affected checks;
   the coverage test names any new method or error without a MUST check.
3. **Bump pins in lockstep**: every `0.0.0-spaces-alpha-*` in package
   manifests and the `pnpm-workspace.yaml` overrides. Check each alpha
   package in the new tree for a release that outranks the alpha range
   (bare `0.0.0`, or a prerelease sorting after `spaces-alpha`); add an
   override for any new one.
4. **Diff the upstream packages** (`npm pack` both builds of
   `@atproto/space`, `oauth-scopes`, `syntax`) and implement the changes
   in the engine, PDS and oauth-provider, with tests.
5. **Recalibrate**: run the conformance suite against the reference
   (`pnpm --filter @getcirrus/space-conformance-matrix test`), re-pin the
   partition and update the matrix README's divergence table and its alpha
   version. If a build can't be onboarded, leave pins and suite on the old
   build and say so, rather than letting the matrix rot.
6. **Check the bundle** (above), update this plan and the docs, and add a
   changeset.

## Not done / next

- **Interop runs** against rsky and a live deployment. The reference is
  covered in-process by the conformance matrix (above).
  bulletin.my's S1 flow is verified live against pds.mk.gg (2026-08-29):
  OAuth with space: scopes, board space creation, delegation →
  credential exchange, reads, registerNotify and listRepos all work
  (on the 0818 alpha; not re-verified since).
  Cross-PDS (S2–S4) remains unexercised against a real foreign PDS.
- **R2 lifecycle rule** must be applied per-install
  (`wrangler r2 bucket lifecycle add pds-blobs --prefix "<did>/staged/" --expire-days 7`);
  `pds init` doesn't automate it yet.
- Blob cache tagging, per-credential rate limits — "Later" per the spec.
- Sending revocations: Cirrus receives `notifyCredentialsRevoked` but, like
  the reference, never revokes credentials it issued (member removal waits
  out the credential's 10-minute lifetime).
- Takedowns: `RepoTakendown` is declared but Cirrus has no takedown
  state; only deactivation (`RepoDeactivated`) is enforced.
- Standalone host package (S9): the engine boundary is in place; no
  package yet.
- Alpha deps (`@atproto/space`, `@atproto/oauth-scopes` at
  `0.0.0-spaces-alpha-20261112204144`) follow the sync process above;
  Renovate is configured to leave them alone.

## Implementation notes (non-obvious)

- DO RPC folds thrown error class names into messages;
  `parseSpaceErrorCode` scans prefix segments to recover the protocol
  error name.
- The vitest workers pool resolves `jose` to its Node build, which breaks
  under workerd; both spaces and any future package using jose in workerd
  tests need the browser-build alias (see `packages/spaces/vitest.config.ts`).
- Rejected DO RPC stub promises double-report as unhandled rejections in
  the pool even when handled; engine tests capture expected errors inside
  `runInDurableObject` instead.
- `@atproto/oauth-scopes@alpha` does not re-export `LexiconSpace`;
  oauth-provider defines the shape locally. Since 1105 a `SpacePermission`
  without collections or manage ops has those fields `undefined`, not
  empty arrays.
- The SQL order of `(collection, rkey)` is not the STAR archive's order:
  `app.bsky.feed.post/a` sorts before `app.bsky.feed/z` byte-wise. The DO
  orders archive pages by `collection || '/' || rkey` (BINARY collation).
- `@atcute/lexicon-resolver` can't resolve a space type declaration:
  it validates the fetched doc against `@atcute/lexicon-doc`, whose
  def-type whitelist has no `type: "space"`, so a valid declaration
  throws `InvalidLexiconSchemaError` (invalid_literal at
  `.defs.main.type`). `permission-sets.ts`'s `resolveSpaceDeclaration`
  replicates the resolver's DID-doc → PDS → proof-CAR → signature-verify
  steps itself, then validates `defs.main` against the local shape —
  full proof verification, tolerant parse. Remove once upstream
  lexicon-doc learns the `space` def type.
- Deleted spaces read as `SpaceNotFound`, never-written spaces as
  `RepoNotFound`; `authorizeSpaceSync` alone answers `SpaceDeleted`
  (tombstone retained in the space DO).
