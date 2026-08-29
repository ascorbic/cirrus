# Standalone Space Host

- Status: Draft
- Date: 2026-08-29
- Depends on: `@getcirrus/spaces` (the engine), the spaces alpha deps pinned there
- Scope: a new deployable, `@getcirrus/space-host` — a dedicated space authority with no account attached. Realises S9 from [the spaces spec](../in-progress/spaces-spec.md).

## Summary

A Worker that serves one org DID as a space authority: it issues credentials, tracks writer sets, fans out notifications, manages membership, and optionally holds the org's own permissioned repo. No public repository, no firehose, no OAuth provider, no user.

The design center is the **app developer**: the host's only management surface is a programmatic admin API. Human operators are served by clients of that API — a CLI first, then a bundled web UI that is itself a normal atmosphere app. The community operator uses software built exactly the way we tell app developers to build.

## User stories

**App developer (primary)**

- As an app developer, I want my app to offer "create a group" backed by a space host I operate, so that groups exist without electing one member's PDS to host and rule them. *Test: the app's backend creates a space over the admin API with its own service identity.*
- As an app developer, I want to decide membership programmatically per request, so that my app's social logic — mutuals, invites, paid tiers — is the access policy. *Test: managing-app policy pointing at the app; credentials granted and refused per its `checkUserAccess` verdicts.*
- As an app developer, I want the host to administer with service identities rather than shared tokens, so that credentials rotate and audit like everything else. *Test: an admin call signed by a non-allow-listed DID is refused; rotating the app's key requires no host change.*

**Community operator (via the default clients)**

- As a community operator, I want our spaces owned by an org DID on infrastructure we control, so that the community outlives any individual member's account. *Test: fresh deploy from the template; the reference alpha resolves the did:web document and completes a credential exchange.*
- As a community operator, I want to manage members from a web UI I sign into with my own PDS account, so that moderation needs a browser, not a terminal. *Test: superadmin logs into the bundled UI via PDS OAuth, adds and removes a member; a non-superadmin login sees nothing.*
- As a community operator, I want removal to lock a member out within a bounded window, so that revocation is a moderation tool and not a suggestion. *Test: remove; next credential refused; the old one fails after expiry (≤2h).*
- As a community operator, I want to post announcements as the org itself, so that official content is attributable to the community. *Test: admin write via UI or CLI lands in the org's repo; credentialed readers see it.*
- As a community operator, I want to survive alpha breakage with one reset command, so that pre-release protocol software doesn't need a migration plan. *Test: bump the schema constant; endpoints refuse clearly; reset; clean.*

**Member (on their own PDS — already true of the protocol; the host must not break it)**

- As a member, I want to write to the community space from my own PDS with apps I already use, so that joining doesn't mean another account. *Test: writers on Cirrus and the reference alpha; the host's `listRepos` converges after each write.*
- As a member, I want my posts stored in my own repo — exportable, deletable by me — so that leaving the community doesn't surrender my words to it.
- As a member, I want one credential from the org to read the whole space, so that access doesn't require negotiating with every member's PDS.

**Syncer operator**

- As a syncer operator, I want to register once and be poked on every write, so that I can index the space without polling every member's PDS. *Test: registerNotify, then writes from two PDSes each produce a poke.*
- As a syncer operator, I want to be told when a space is deleted, so that I drop data I have no right to hold. *Test: deleteSpace fans out notifySpaceDeleted.*

**Hosting provider (later)**

- As a hosting provider, I want one deployment to serve many orgs' authority DIDs, so that small communities get org-owned spaces without each running a Worker. Multi-tenancy forces per-space authority and keypair configuration in the engine; the first cut must not prevent it and does not build it.

## Architecture

One Worker, the two engine DO classes (`SpaceDurableObject`, `SpaceIndexDurableObject`) with a host config supplying the org DID and keypair. Environment: `HOST_DID`, `HOSTNAME`, `SIGNING_KEY` (+ public), `SUPERADMIN_DIDS` (comma-separated), the DO bindings, optional `BLOBS`.

### Identity

did:web only in the first cut: the Worker serves its own DID document with the `#atproto` verification key and `#atproto_space_host` service entry. did:plc needs registration and rotation-key custody tooling and is deferred.

### One admin auth scheme

Every admin method accepts exactly one thing: **a method-bound atproto service JWT whose `iss` is on the admin allow-list** (`SUPERADMIN_DIDS` plus the org DID itself, which is implicitly super). Verified with the same inbound service-JWT path the engine already uses for `notifyWrite`, plus `jti` replay-guarding in the engine's replay table.

Three producers, no special cases:

1. **App backends** sign directly with their own service identity's key.
2. **The CLI** signs with the org's signing key from local config — the org administering itself; no additional credential exists.
3. **The web UI** never signs anything: it OAuths against the *operator's own PDS* (requesting `rpc:` scopes for the admin lexicons with `aud` = the host DID) and asks that PDS for service JWTs via `com.atproto.server.getServiceAuth`, one per call.

When an admin performs an org action (writes into the org repo, space management), the session maps to the org identity after the allow-list check — repo and ownership checks compare against the authority DID, with the acting admin's DID logged.

### The default management app

A static SPA bundled with (and served by) the host Worker, but architecturally just an atmosphere app: PDS OAuth login, `getServiceAuth` per admin call. Spaces list, member add/remove, org announcements, delete, reset/status. Because it is only a client of the admin API, it can later be hosted centrally, replaced, or ignored by app developers without touching the host.

### Policies

Unchanged from the engine: `public`, `member-list`, `managing-app`; app gating via `allowList`. The default app **edits the native member list** through the admin API rather than sitting in the credential path — a static list in the host fails less than a per-mint network hop to a UI app. `managing-app` remains the path for genuinely dynamic membership.

### Reads, writes, blobs

Reads are credential-only (there are no user sessions). The org's own repo is served by the engine's repo-host endpoints; org writes go through the admin API with optimistic validation (fail-open on unknown lexicons, like Cirrus). Blobs exist only if the org writes blob-bearing records; staged uploads and per-space prefixes work as in Cirrus, minus the public blob path entirely.

### Reset and lifecycle

Same schema-version refusal and reset semantics as Cirrus, simpler: there is no public repo to protect, so reset wipes the deployment's data wholesale. `status` and `reset` live on the admin API and work while the engine is refusing.

## Package layout

- **`@getcirrus/space-host`** — the Worker: DID document, admin API, admin-auth verification, the bundled management SPA, host adapter for `createSpaceRoutes`. No engine changes required for the single-tenant cut.
- **`space-host` CLI** — bundled bin, mirroring `pds spaces` (create, delete, members, export, reset, status) plus init/secrets scaffolding.
- **`create-space-host`** — scaffold, once the shape settles.

## Phasing

**Phase 1 — host + CLI.** Worker, did:web document, admin API with service-JWT auth and replay guard, engine routes mounted, CLI signing with the org key. Interop test: credential exchange and writer flow against Cirrus and the reference alpha.

**Phase 2 — the default app.** Bundled SPA with PDS OAuth + `getServiceAuth`, member management, org announcements. This phase is also the reference implementation of the app-developer path.

**Phase 3 — app-platform polish.** Dynamic admin list (superadmin grants/revokes admin DIDs via the API), per-space provisioning conveniences, rate limits per admin identity.

**Later.** Multi-tenancy (per-space authority + keypair in the engine), did:plc identities, central hosting of the management app.

## Open questions

- Admin lexicon NSIDs: extend `gg.mk.experimental.*` like the Cirrus admin surface, or mint a proper namespace now, knowing app developers will code against it?
- `getServiceAuth` on third-party PDSes: the official PDS caps service-JWT lifetimes and deny-lists some `lxm` values; confirm custom admin NSIDs pass through on official and reference alpha PDSes, and what OAuth scope shape they demand for scoped sessions.
- Whether the bundled SPA ships in Phase 1 as a read-only status page (cheap) or waits for Phase 2's full OAuth flow.
- Export format for a host with many spaces (one CAR per space, as Cirrus, presumably — but the org repo is the only repo it can export; members' repos live elsewhere).
