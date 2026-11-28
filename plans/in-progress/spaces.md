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

## Alpha 20261117141222 (2026-11-19)

Pins bumped from 1112, passing 1113 (`20261113224550`). Neither build
changes a space lexicon or the code of `@atproto/space` /
`@atproto/oauth-scopes`. 1113 publishes the alpha's internal deps as
exact versions rather than `^` ranges. That isn't enough to stop bundling:
exact sibling pins already failed to rescue npm at 1105. 1117 merges main.
Its one spaces behaviour change is the reference refusing app passwords
on every space route, which Cirrus already did. No new outranking broken
releases.

The 1117 reference fixed `credential.garbage-attestation-refused` (a
malformed attestation is now `InvalidClientAttestation`, not a 500), so
the matrix is 104 pass, 1 pinned divergence
(`writes.delete-in-missing-space`), the slow check skipped.

### Two-sided checks (2026-11-21)

An audit found checks that pass against a host where the feature is
broken. The motivating case: Cirrus's attestation verification always
failed in production, but no check sent a valid attestation. Changes:

- The syncer inbox now also acts as an OAuth client. It serves
  `client-metadata.json` with an ES256 `jwks`, and `inbox.attest()` mints
  attestations.
- New checks `credential.valid-attestation-issues` and
  `credential.valid-attestation-unlisted-refused`.
- The refusal checks run a success-path control when an inbox is available,
  using a new optional `uses` capability. Without one, their detail says
  what was not checked.
- The managing-app fail-closed checks now need an inbox, for the control.
- Several checks now require a 4xx where they used to accept anything but
  200, or require the error name.
- New check `policy.personalspace-owner-admitted`.

109 checks. Reference matrix: 107 pass, 1 divergence, 1 slow skip. Both
Cirrus runners pass. The in-process routes verify a real attestation
against the inbox's metadata.

Cirrus answers a malformed `space` with `400 InvalidSpaceUri`, which no
lexicon declares. The reference answers XRPC's generic `InvalidRequest`.
The `must` check reports the name but does not require it.

## Alpha 20261124235736 (2026-11-25)

Cut from `permissioned-data-alpha@1f510f8e`, the last alpha before the
1 December beta. Upstream wrote a migration note for this release
(`alpha-migrations/prompt-11-24-26.md` on `permissioned-data`); it is
the best summary of what changed.

- **Space URIs**: `at://{did}/space/{type}/{skey}` → `at:space/{did}/{type}/{skey}`
  (records append `/{author}/{collection}/{rkey}`). Everywhere a space
  URI travels: params, record `uri`s, delegation/credential `sub`, the
  MAC headers' `space`/`uri`, STAR metadata. `space-uri.ts` parses only
  the new form (strict, as the reference parses params); a parity test
  runs it against `@atproto/syntax`'s `isSpaceRefString`. The old form
  is only tolerated upstream inside alpha-era record values, which
  Cirrus never parses.
- **Stored state**: space DOs are named by URI, so old spaces are
  unreachable under new URIs. Schema version 4 and `pds spaces reset`,
  per the alpha policy. (Upstream migrated its databases; the beta is a
  clean cut regardless.) Requests for old spaces answer `SpaceNotFound`,
  not 503, because the new URI names a fresh DO.
- **App passwords**: refused with `400 InvalidToken` ("Bad token
  scope"), matching the reference (previously 403).
- **importRepo scope**: read plus create/update/delete on `collection:
  '*'`, which only a `space:` grant with `collection=*` satisfies (a
  grant without `collection` allows no writes at all).
- **Packaging**: `@atproto/space` depends on the stable
  `star@0.0.1` / `lex-cbor@0.1.11` / `lex-data@0.1.11` and on its alpha
  siblings at exact versions, and not every package publishes each build
  (lex-cbor/data/json and star stayed at 1117). The workspace overrides
  are removed; the install resolves without broken releases. Bundling
  stays: it still keeps consumers off alpha ranges.
- **Not done**: `com.atproto.server.reserveKemKey` (entryways only) and
  the reference's activation check that the DID document publishes the
  PDS's `#atproto_kem` key. Cirrus surfaces the latter through
  `pds spaces status` instead of refusing activation. `importRepo`
  still replaces the repo outright rather than indexing a diff; the end
  state is the same apart from blob release timing.

### Conformance at 1124

111 checks. Every space URI the suite builds is `at:space/`, and the
checks that read URIs back (createSpace, record `uri`s, listSpaces,
credential and delegation `sub`, the MAC headers) require the new form.
New MUST checks `request.legacy-space-uri-rejected` and
`request.handle-space-authority-rejected` (each with a positive control
on the same space) require `400 InvalidRequest` for the old form and for
a handle authority; `request.invalid-space-uri-rejected` now requires the
same name.

- **Reference (matrix):** 109 pass, `writes.delete-in-missing-space`
  still pinned, the slow `notify.registration-expired` not run. Before
  the port, 18 checks failed against 1124 on the URI form alone.
- **Cirrus (both runners):** pass. They first failed the two new checks
  on the error name only: Cirrus answered `InvalidSpaceUri`, which no
  lexicon declares. Cirrus now answers `InvalidRequest`.

### PLC `If-Match` (2026-11-25)

plc.directory gives `If-Match: *` submissions (updates of an existing
DID) per-identifier rate limits instead of the tighter per-IP ones
(did-method-plc #174/#183; 412 "DID not registered" if sent for a DID
that doesn't exist). Cirrus sends it on every operation with a `prev`,
from the Worker's `submitPlcOperation` and the CLI, never on genesis.
It matters for Workers' shared egress IPs with every PDS publishing
`#atproto_kem` keys at the beta.

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

- **Interop runs** against rsky and other implementations. The reference
  is covered in-process by the conformance matrix (above), and live:
  - **2026-11-28, 1124 alpha, cross-PDS (S1–S4) verified live** between
    pds.mk.gg (Cirrus, `did:web`) and an account on Bluesky's hosted
    spaces alpha PDS, through bulletin.my (whose source pins 1124). Both
    directions work with no warnings in `wrangler tail`: each account
    reads and posts on the other's board. That covers OAuth with
    bulletin's `include:my.bulletin.permissions` set, board (managed
    space) creation, delegation tokens minted by each host and accepted
    by the other, credentials issued after the managing app's
    `checkAccess`, MAC'd credentialed reads against the `#atproto_kem`
    key, signed `notifyRepoUpdate` in both directions, and the syncer
    webhooks.
  - bulletin's boards are managed spaces; its `checkAccess` grants read
    to an account following the owner and write to mutual follows, asked
    of the Bluesky AppView (`app.bsky.graph.getRelationships`). A test
    account therefore needs follows the AppView has indexed.
  - Earlier: bulletin.my's S1 flow on the 0818 alpha (2026-08-29).
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
  `0.0.0-spaces-alpha-20261124235736`) follow the sync process above;
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
