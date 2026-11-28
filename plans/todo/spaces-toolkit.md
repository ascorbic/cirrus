# Spaces Toolkit

- Status: Draft
- Date: 2026-11-28
- Replaces: `standalone-space-host.md` (now the Host component below)
- Depends on: `@getcirrus/spaces` (engine), `@getcirrus/space-conformance`,
  the spaces beta (1 December 2026). Build against the beta, not the alpha.

## Why

Every spaces app rebuilds the same machinery. bulletin.my, a small app, has
its own syncer engine, credential handling, `checkAccess` route, service
auth and AppView follow lookups. That machinery is the hard part (MACs,
LtHash folding, 10-minute credentials, webhook registration, purging on
deletion) and the part apps get wrong. Upstream ships `@atproto/lex-space`
(`SpaceClient`, `SpaceReader`, `SpaceManager`) for talking to spaces and the
reference PDS for hosting them; persistent sync, access-control kits and
multi-host testing are not shipped.

The aim is the de-facto toolkit for building spaces apps: everything between
"I have a space type lexicon" and "my app works across PDSes in production",
on Workers, where one Durable Object per space fits the protocol exactly.
Wrap `@atproto/lex-space` where it fits; don't compete with it.

## What a spaces app is made of

1. Where the space **lives**: authority and host.
2. Who's **in**: a policy, or a managing app answering `checkAccess`.
3. Members **writing** from their own PDSes via OAuth `space:` scopes.
4. A **syncer** reading every writer's repo, verifying and indexing it.
5. A **client** showing it.

Cirrus covers 1 and the PDS side of 3 today. The toolkit covers all five,
plus testing and operations.

## Components

### Sync: `@getcirrus/space-syncer` (highest priority)

A library and a deployable Worker that keeps verified, queryable copies of
spaces.

- **Lifecycle**: register via `authorizeSpaceSync` with `notify`; answer
  `confirmRegistration`; receive `notifySpaceUpdate` (`repoWrite`,
  `repoRemoved`, `spaceDeleted`, `registrationExpired`); renew credentials
  before their 10-minute expiry; walk `listWriters`; catch up per writer
  with `listRepoOps`, folding ops into the LtHash and checking it against the
  commit's `data`; bootstrap or recover with `getRepo` STAR; verify MACs on
  everything.
- **Views**: records validated against the space type's lexicons (lenient on
  read, as upstream advises for alpha-era values; strict on write), stored
  per space in DO SQLite or D1. A query API for the app and a change feed
  (WebSocket via the hibernation API) for clients.
- **Privacy as default behaviour**: purge a writer's records on
  `repoRemoved`, a space on `spaceDeleted`, everything held under a lapsed
  registration; honour revocation; keep an audit log of what was held and
  dropped. An app should not have to remember to delete.
- **Safe outbound fetch**: https only, manual redirects, timeouts. Endpoints
  come from DID documents.
- Starting point: the conformance suite already contains MAC verification,
  `listRepoOps` folding, STAR verification and the webhook inbox
  (`createSyncerInbox`).

### Access: `@getcirrus/space-access`

A kit for managing apps.

- **`checkAccess` handler builder**: verifies the host's service auth
  (`aud` is `did#service`, `iss` is the space authority), handles anonymous
  calls with no `repo`, answers within the host's 10-second budget, caches.
- **Rules**, composable: follows and mutuals via the AppView (bulletin's
  rule), member lists, invite codes, entitlements (a payment provider's
  webhook writes them; see the EmDash example), role tables, expiry.
- **Invites**: links that resolve to `putMembers` on a memberspace or a
  grant in the managing app.
- **Roles**: the protocol has read and write. Map app roles (moderator,
  poster, viewer) onto those plus authority-authored records for the rest
  (bulletin's `my.bulletin.removal` is the pattern).

### Host: `@getcirrus/space-host`

The former standalone-space-host plan, updated for the 1124 alpha.

- **Role**: a space authority with no account attached: an app or org DID
  owning spaces, so groups don't live on one member's PDS.
- **Discovery**: there is no `#atproto_space_host` any more. The authority's
  `#atproto_pds` is the space host (`spaceHostAud` is `${did}#atproto_pds`),
  so the host publishes `#atproto_pds` pointing at itself, with no public
  repo, firehose or login behind it. Document that clients signing in there
  must fail clearly, and never request a crawl.
- **Keys**: `#atproto` and `#atproto_kem` in the DID document. MACs cover the
  org's own repo (announcements, published policy and members), so the KEM
  key is required. did:web only in the first cut.
- **Admin auth through the standard methods**: no custom admin API.
  `createSpace`, `updateSpace`, `deleteSpace`, `putMembers`, `removeMembers`,
  `removeWriter`, `createRecord`, `exportSpaceMeta` and the rest, authenticated
  by a method-bound service JWT whose `iss` is on the admin allow-list, with
  `jti` replay-guarded, mapped to the org DID with full trust. The engine
  supports this through `SpaceRoutesHost.authenticate` without changes. Apps
  code against `com.atproto.space.*`, which works against any authority
  host. Only `status` and `reset` need custom NSIDs.
- **Producers of admin JWTs**: app backends with their own service identity;
  the CLI signing with the org key; a bundled admin UI that OAuths against the
  operator's own PDS and asks it for `getServiceAuth`. Open: whether the
  reference PDS mints service JWTs for `com.atproto.space.*` with a foreign
  `aud`, and the `rpc:` scope shape it wants. Testable now with the hosted
  alpha account.
- **Policies**: memberspace for admin-edited lists (with `publishMembers` if
  members should be visible), managedspace for app logic, `allowedApps` for
  app gating.
- **Rate limits in the first cut**: a community host takes `notifyRepoUpdate`
  from any authorised writer (anyone, under `publicWrite`) and fans out to
  every syncer. The reference limits inbound `notifyRepoUpdate` per writer
  (1,500/hour, 10,000/day).
- **Multi-tenancy**: one deployment serving many authorities, either one app
  DID with many spaces or a did:web per community so it can outlive the app.
  This is an engine refactor: `operatorDid`, `getKeypair()` and
  `getKemPrivateKey()` are global today and `routes.ts` compares against
  `host.operatorDid` throughout (space-host checks, repo checks, credential
  audience, `checkAccess` issuer). Don't add more single-operator
  assumptions.
- **Lifecycle**: schema-version refusal and reset as in Cirrus; `status` and
  `reset` work while refusing. Export is `exportSpaceMeta` (policy, members,
  writers) plus the org repo's `getRepo` STAR.

### Client: gated reads

- **`spaceFetch`**: obtain and refresh a credential (from a delegation token
  or tokenless where policy allows), sign requests, request and verify MACs,
  and fetch gated records and blobs. A small, dependency-light function for
  apps and servers that need one private thing without a full syncer (the
  EmDash installer is the motivating case).
- Thin helpers over `@atproto/lex-space` for browser apps; no parallel SDK.

### Lexicons and permissions

- Author and publish space type declarations and permission sets: DNS TXT,
  `com.atproto.lexicon.schema` records, signature checks.
- Lint against upstream rules: collections must be resolvable record
  lexicons (enforced by `lex install` since 1124), `key`, `title`.
- Consent preview: what a user sees when an app requests
  `include:<set>` on Cirrus and on the reference, and what the grant allows
  (done by hand for bulletin on 2026-11-25; make it one command).

### Testing: `@getcirrus/space-testkit`

- Multi-host harness: the reference PDS in-process (`dev-env`, as the matrix
  does), Cirrus routes in-process, test identities (did:key, did:web), a fake
  AppView for follow graphs (bulletin-style rules depend on one), a syncer
  inbox, a fake payment provider. Apps run cross-PDS scenarios offline in CI.
- Fault injection, packaged from the tests already written: slow or failing
  managing app, redirecting endpoints, key rotation, revoked credentials,
  lapsed registrations, deletion mid-sync.
- App conformance, extending the suite beyond hosts: a managing app answers
  anonymous calls and fails closed; a syncer purges on `spaceDeleted`,
  verifies MACs, handles `registrationExpired`. Same two-sided style.

### Operations

- Per-space dashboard: writers, registered syncers, queue depth, failed
  notifications, credential issuance.
- Migration and backup with STAR, including to and from the reference
  (cross-implementation import is untested; prove it before the hosted alpha
  PDS is deleted).
- The weekly "what changed" report: the alpha sync process and the matrix,
  published per upstream build.

### Scaffolding

`create-space-app`: OAuth client, space type lexicon and permission set,
managing app, syncer, optional host, deployable together, from one of the
example apps below.

## Example apps

Each is a deployable reference that also proves a set of components. Build
them in this order.

| App                                  | Policy                             | Components it proves                                                           |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| **Paid EmDash plugins**              | managedspace (entitlements)        | access (entitlement rule), `spaceFetch`, space blobs, optional host            |
| **Community board** (bulletin-style) | managedspace (follows)             | syncer, access (follow rules), testkit's fake AppView                          |
| **Members-only newsletter**          | managedspace (subscriptions)       | syncer views, access (payment webhook), email digests from the change feed     |
| **Small-group chat**                 | memberspace                        | syncer change feed, many writers, removal purge                                |
| **Event invites and RSVPs**          | memberspace, optional `publicRead` | invites, authority-authored event records, attendees' RSVPs in their own repos |
| **Team wiki**                        | memberspace on an org host         | host, roles mapping, `exportSpaceMeta` backups                                 |
| **Private bookmarks**                | personalspace                      | the minimal case: client only, no syncer, no host                              |

### Paid EmDash plugins (flagship)

RFC 0001 already reserves the hooks: the release record's `auth` open union
(no variants defined), artifacts' `requiresAuth`, Cumulus refusing to serve
or cache gated blobs, and "Defining gated package authentication" deferred to
a follow-on RFC. Spaces can be that follow-on.

**Shape.**

- The **public** release record stays in the publisher's repo, signed as
  today, with full metadata, `declaredAccess`, SBOM and, crucially, the
  artifact `checksum`, with `requiresAuth: true` and no public blob. The
  aggregator indexes paid plugins like free ones; search, capability review
  and labels work unchanged.
- `auth` gains a variant, e.g.
  `com.emdashcms.experimental.package.release#spaceAuth`, naming a space:
  `at:space/{publisherDid}/com.emdashcms.experimental.package.store/{slug}`.
- The **bytes** live in that space: a record per release (keyed like the
  release, `<package>:<version>`) holding the bundle as a space blob. Space
  blobs are served only by credential-gated `com.atproto.space.getBlob` with
  `Cache-Control: private, no-store`, never by `sync.getBlob`.
- The space is a **managedspace** whose managing app is a licensing service
  (`did:web:…#emdash_licensing`), run by the publisher or by a marketplace
  on many publishers' behalf. Its `checkAccess` answers from entitlements a
  payment provider's webhook writes.

**Install.** The site (or its admin) presents a delegation token to the
publisher's space host, gets a credential if `checkAccess` says yes, fetches
the release record and blob with MACs (`spaceFetch`), then verifies the bytes
against the checksum in the **public** signed release record and continues
with the normal consent and install path. Integrity never depends on the
space; the space only decides who may download.

**Whose identity.** A delegation token is a JWT signed by the issuer's
`#atproto` key, verified against its DID document. The site needs no PDS,
only a did:web document with an `#atproto` key, which is what the planned
site-identity RFC provides. That makes licences per site (seats are
entitlements per site DID) rather than per person. Until then, the admin's
own atproto account can be the licensee.

**Updates.** The site learns of new versions from the aggregator's public
`listReleases` as now, and downloads them the same way. No syncer needed.

**Revocation.** A refund, chargeback or lapsed subscription turns
`checkAccess` false: no new downloads or updates within the 10-minute
credential lifetime. Installed code keeps running; this gates distribution,
not execution. That is deliberate: the sandbox can't phone home outside
`allowedHosts`, and runtime licence checks would fight it.

**Properties worth stating.**

- Publishers own the space and the bytes on their own spaces-capable host,
  and can switch payment provider or marketplace by changing `managingApp`
  with `updateSpace`, without re-publishing.
- No new account system: buyers and sites authenticate with atproto
  identities they already have.
- A labeller or security scanner can be granted read through `checkAccess`
  and review paid bundles without making them public.
- Cumulus stays out of gated bytes, as the RFC requires.

**Open questions.** Site key custody on Workers for did:web site identity;
whether the managing app is per publisher or a shared marketplace service by
default; trials and tiers (one space per tier, or `checkAccess` logic);
mirror availability for paid bytes when a publisher's host is down; how the
EmDash admin UI surfaces "requires purchase".

## Phasing

1. **After the beta**: re-port to the beta, then testkit and syncer, proven
   by porting the community board onto them.
2. Access kit and `spaceFetch`, proven by the paid-plugins example against a
   fake payment provider in the testkit, then a real one.
3. Host (single-tenant), with the admin UI.
4. Multi-tenant host, `create-space-app`, the remaining examples.

Ongoing: the matrix and weekly report track upstream.

## Limits

Cirrus is single-account, so it can't host many people's repos for one space.
No component here makes a space's data secret from its own readers; spaces
are access control, not encryption. The protocol is pre-beta and may move
again on 1 December.
