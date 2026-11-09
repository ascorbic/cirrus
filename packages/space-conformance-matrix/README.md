# @getcirrus/space-conformance-matrix

Runs [`@getcirrus/space-conformance`](../space-conformance) against the
**atproto reference PDS** — the implementation every space must interoperate
with — so the suite is calibrated, not just self-consistent.

Private, test-only. Nothing is published from here.

## Why

A conformance suite that only ever runs against its own author's
implementation proves nothing: it can quietly encode one PDS's habits as if
they were the protocol. This package is the control. It boots the reference
PDS in-process with [`@atproto/dev-env`](https://www.npmjs.com/package/@atproto/dev-env)
(a real PLC plus the reference `@atproto/pds`, backed by SQLite — not a mock),
creates an operator account, and runs the full check catalog against it.

- A `must` check the reference **passes** is genuinely universal.
- A `should` check the reference **fails** is stale by definition, so the
  matrix allows none.
- A `must` check the reference **fails** is either a real gap in the alpha
  reference or an over-specification in our check. Each such case is pinned and
  cited in [`test/reference-matrix.test.ts`](test/reference-matrix.test.ts),
  so "the reference fails this" is a reviewed fact, not a surprise.

The test pins the **whole partition**: which checks pass and which diverge
(nothing skips — see below). If a passing check regresses, CI fails. If a
pinned divergence starts _passing_ — the reference caught up, or a check
quietly weakened — CI also fails, forcing the list to be re-examined. The
matrix is only worth having if it cannot silently rot.

## What the run provides

Every capability the catalog can ask for, so nothing skips:

- an operator account (`seed.createAccount`) and its full-access session;
- the reference's own blob endpoints and `getDelegationToken`;
- harness identities the reference can resolve — each a tiny local HTTP
  server publishing a `did:web:localhost%3A<port>` document with an
  `#atproto` key and an `#atproto_pds` service (the reference resolves
  `localhost` did:webs over http, and dev-env disables SSRF protection) —
  playing a reader, a writer's PDS, a foreign space authority and a
  stranger;
- a syncer inbox (one of those identities) that records the reference's
  `notifyWrite` / `notifySpaceDeleted` deliveries and answers its
  `managedspace.checkUserAccess` queries;
- the dev-env PLC as `target.plcDirectory`, so the operator's did:plc
  document (and its `#atproto_kem` key) resolves.

## Pinned reference divergences (alpha `0.0.0-spaces-alpha-20261105160032`)

| Check                                    | Why the reference diverges                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `writes.delete-in-missing-space`         | `deleteRecord` declares `SpaceNotFound`, and `deleteSpace`'s description says writes to a deleted space fail with it. The reference's `deleteRecord` checks whether the record exists before anything touches the space (`hasRecord` → no-op, for idempotency), so a delete in a missing or deleted space is a silent 200 and the `ensureRepo` space check (changeset `brave-spaces-exist`) is never reached. Its create, put and applyWrites do answer `SpaceNotFound`. |
| `space.reads-after-delete-not-found`     | Same `deleteSpace` sentence, read side ("afterwards, reads … fail with SpaceNotFound"). The reference's read handlers never consult the space row: once the owner's repo is deleted they answer `RecordNotFound`, `RepoNotFound`, `BlobNotFound` or an empty 200 listing, never the `SpaceNotFound` each of them declares.                                                                                                                                               |
| `credential.garbage-attestation-refused` | `ClientAttestationVerifier.verify` calls `parseSpaceToken` outside its `invalid()` wrapper, so a structurally malformed client attestation escapes as an uncaught `SpaceTokenError` — 500 `InternalServerError` where the lexicon declares `InvalidClientAttestation`. A well-formed but unverifiable attestation is refused correctly (`credential.unverifiable-attestation-refused` passes).                                                                           |

Everything else in the catalog passes against the reference, including the
identity-gated checks (foreign readers, writers' `notifyWrite`, foreign
authorities' credentials and revocations) and the inbox checks, which
earlier alphas had to skip because the reference could not resolve harness
identities.

## Running

```bash
pnpm --filter @getcirrus/space-conformance-matrix test
```

`@getcirrus/space-conformance` must be built first (`pnpm build`), which CI
does before `pnpm test`. The test also pins the suite's `ALPHA_BUILD`: bumping
the alpha without re-running and re-pinning this matrix fails it. The reference stack pulls `better-sqlite3` (a native
module) and the `@atproto/lex*` family, which the spaces alpha published with
leaked `workspace:*` specifiers — both are handled by `pnpm-workspace.yaml`
(`allowBuilds` and `overrides` respectively).
