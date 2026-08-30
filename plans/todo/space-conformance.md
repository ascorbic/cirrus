# space-conformance

- Status: Rough draft
- Date: 2026-08-30
- Depends on: the pinned `@atproto/space` / `@atproto/oauth-scopes` alpha builds; the vendored spaces lexicons; the upstream PDS design spec (`docs/superpowers/specs/2026-04-22-permissioned-data-pds-design.md` on the alpha branch)
- Scope: a black-box conformance suite for atproto spaces implementations — any PDS or standalone space host, over the wire. Incubated in this repo as a self-contained package; named and structured for extraction to neutral ground.

## Why it doesn't exist yet

`bluesky-social/atproto-interop-tests` is static vectors with no spaces content. The reference implementation's tests are white-box. This repo's own checker (`apps/check`, deployed at check.cirrus.earth, which rsky already runs) is the nearest live harness and has no spaces coverage. Nobody has a suite that exercises the multi-party flows — credential issuance, foreign writers, syncer fan-out — against an arbitrary live host.

## Design

### One check model, three runners

A check is an async function over a transport plus machine-readable metadata:

```ts
interface Check {
	id: string;                       // "credential.dpop-replay-refused"
	tier: "must" | "should" | "info";
	citations: Citation[];            // lexicon def/error, proposal anchor, design-spec section
	needs: ("operator" | "identities" | "syncer-inbox")[];
	destructive?: boolean;            // creates/deletes spaces on the target
	slow?: boolean;                   // expiry-window checks
	run(ctx: CheckContext): Promise<CheckResult>;
}
```

`CheckContext` carries a `fetch`, a target descriptor (host origin, target DID), an optional operator credential, and an identity provider. The same checks then run three ways:

1. **vitest adapter** — in-process against the local Hono app. Replaces a slice of today's `routes.test.ts`; the unit suite and the conformance suite stop being separate truths.
2. **CLI runner** — `space-conformance run --target https://host --report out.json` against any live implementation.
3. **check.cirrus.earth adapter** — the existing checker UI (`apps/check`) grows a Spaces tab that renders the same results.

### Tiers, with citations

- **MUST** — specified behavior: lexicon wire shapes, declared error names, auth requirements from the proposal and the upstream PDS design spec. Every MUST check cites its source; a check that can't cite one isn't a MUST.
- **SHOULD** — reference-implementation behavior the spec leaves open (descending listRecords, cursor-on-full-page, commit withheld on a full oplog page). Calibrated empirically: the suite runs against the reference before judging anyone, and a SHOULD check the reference fails is stale by definition.
- **INFO** — implementation-defined or our own hardening (e.g. writer-set monotonicity). Reported, never failed.

The suite never auto-loosens a MUST; deciding the lexicon doesn't mean what it says is a human act.

### Identities: the checker plays every foreign role

Multi-party flows need a reader who isn't the operator, a writer "on another PDS", and a syncer. All three only require resolvable DIDs with published keys, so the identity provider mints them:

- **Hermetic mode** — throwaway `did:plc` identities registered on a local PLC directory. One CI job runs local PLC + reference PDS container + Cirrus under `wrangler dev` + the checker; S2–S5 run entirely on localhost. This is the merge gate.
- **Live mode** — `did:web` path identities under the deployed checker's own domain (`did:web:checker.example:actors:x`). Used for the published matrix against hosted targets; never a gate.

The checker signs delegation tokens as its reader, service JWTs as its writer, and exposes an inbox endpoint as its registered syncer to assert fan-out actually arrives.

### Coverage is computed

A generator walks the vendored lexicons: every method and every declared error name must map to at least one MUST check. New upstream lexicon → visible coverage gap the moment it's re-vendored, with no human memory involved.

### Check catalog (sketch)

- **discovery** — `#atproto_space_host` service entry; key fallback to `#atproto`.
- **delegation** — typ, 60s expiry, aud = `<authority>#atproto_space_host`, signature against the issuer's key, single use (replay refused).
- **credential** — typ, `cnf.jkt` binding, issuer = authority, cross-space use refused, DPoP proof required with `ath` on use and without on obtain, proof jti replay refused.
- **writes** — batch atomicity, RecordAlreadyExists/RecordNotFound semantics, 200-write cap, validationStatus, rev monotonicity.
- **sync** — listRepoOps `(rev, idx)` cursors, commit only at head, stale values omitted, pre-window `since` starts from oldest with no error; getRepo CAR passes `verifyRepoCarFull`; folded ops hash equals the signed commit hash; `excludeValues` two-root form.
- **blobs** — space blob absent from public `sync.getBlob` and `sync.listBlobs`; credential-gated `getBlob` with `no-store` semantics.
- **host role** — policy enforcement per variant; notifyWrite iss/aud checks; registration expiry reported; deleteSpace → SpaceDeleted from `getSpaceCredential`; fan-out delivery (via the checker's inbox).
- **simplespace** — management method auth, union parsing, unsupported-variant errors, owner checks.
- **errors** — exact error-name conformance across all of the above (SpaceNotFound vs RepoNotFound vs SpaceDeleted distinctions).

### Output

Per-check JSON — id, tier, result, citations, evidence — keyed by (suite version × alpha build × implementation × target). An aggregator publishes the matrix; a matrix row is visibly stamped with the build it was tested against, so stale results read as stale rather than wrong.

### Update loop

Owned by the Thursday sync agent: re-vendor lexicons, diff → affected checks by citation; run the suite against the reference to recalibrate SHOULDs; coverage gaps become new-check work items; failures that can't be resolved leave pins and suite old and the matrix honest ("build N not yet onboarded").

## Package boundaries

`packages/space-conformance` (neutral name, no "cirrus"): vendored lexicons and spec excerpts, the check catalog, the three runners, the coverage generator. Imports pinned `@atproto/*` verifiers only — zero `@getcirrus/*` runtime code — so extraction to a neutral org is a directory move. Static fixtures (token examples, LtHash vectors, CAR files) kept in a `vectors/` dir shaped like `atproto-interop-tests`, ready to PR upstream as its `space/` directory — the blessing wedge.

## Non-goals

Load or performance testing; client-SDK conformance; judging INFO-tier choices; testing confidentiality (spaces are access control, not encryption); replacing the reference's own test suite.

## Phasing

1. **Package + MUST catalog for the repo-host role + vitest adapter.** Migrate the equivalent `routes.test.ts` assertions into it; Cirrus CI becomes the first consumer.
2. **Checker identities + host-role checks + CLI runner + the hermetic matrix job** (local PLC, reference container, Cirrus dev server). Matrix becomes the sync-PR gate.
3. **check.cirrus.earth Spaces tab + live matrix publishing + coverage generator.**
4. **Vectors PR to `atproto-interop-tests`; Thursday agent integration.**

## Open questions

- Does the reference alpha's dev environment expose the local PLC cleanly enough for third-party registration, or does hermetic mode need our own minimal PLC stub?
- How much of the operator tier can run without an implementation-specific login story? (check.cirrus.earth's existing auth handling probably generalizes; the CLI may need a token/OAuth flag per target.)
- Destructive-tier consent UX: flag-gated per run, or a dedicated disposable target account per implementation in the matrix?
- Whether SHOULD-tier calibration runs against one reference version (the pinned build) or tracks its main branch.
