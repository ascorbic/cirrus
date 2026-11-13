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

Every capability the catalog can ask for, so nothing skips but the one slow
check:

- an operator account (`seed.createAccount`) and its full-access session;
- the reference's own blob endpoints and `getDelegationToken`;
- harness identities the reference can resolve — each a tiny local HTTP
  server publishing a `did:web:localhost%3A<port>` document with an
  `#atproto` key and an `#atproto_pds` service (the reference resolves
  `localhost` did:webs over http, and dev-env runs it in dev mode, so its
  SSRF protection is off) — playing a reader, a writer's PDS, a foreign space
  authority and a stranger;
- a syncer inbox: the suite's `createSyncerInbox`, served by the "syncer"
  identity's server. Its base URL is the `notify` endpoint registered through
  `authorizeSpaceSync`, so it answers the reference's `confirmRegistration`
  challenges and records its `notifySpaceUpdate` webhooks; and
  `<syncer did>#atproto_pds` names it as a `managedspace` managing app
  answering `checkAccess`;
- the dev-env PLC as `target.plcDirectory`, so the operator's did:plc
  document (and its `#atproto_kem` key) resolves.

## Pinned reference divergences (alpha `0.0.0-spaces-alpha-20261112204144`)

| Check                                    | Why the reference diverges                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writes.delete-in-missing-space`         | `deleteRecord` declares `SpaceNotFound`, and proposal 0016 (Repo lifecycle) says that when the writer is the space authority "the space must already exist" (changeset `brave-spaces-exist`: such writes are rejected with `SpaceNotFound`). The reference's `deleteRecord` checks whether the record exists first (`hasRecord` → no-op, for idempotency), so a delete in a missing or deleted space is a silent 200. Its create, put and applyWrites do answer `SpaceNotFound`. |
| `credential.garbage-attestation-refused` | `ClientAttestationVerifier.verify` calls `parseSpaceToken` outside its `invalid()` wrapper, so a structurally malformed client attestation escapes as an uncaught `SpaceTokenError` — 500 `InternalServerError` where `authorizeSpaceSync` declares `InvalidClientAttestation`. A well-formed but unverifiable attestation is refused correctly (`credential.unverifiable-attestation-refused` passes).                                                                          |

Both are carried over unchanged from the 1105 alpha. The third 1105
divergence, `space.reads-after-delete-not-found`, is gone with the check: the
1112 lexicons dropped the `deleteSpace` sentence it cited, and the read
methods' `SpaceNotFound` is now a reasoned coverage exemption instead.

Not run here: `notify.registration-expired`, a `slow` check that waits out a
real 10-minute credential before writing. It was run by hand against this alpha (2026-11-13, about 10 minutes) and passed: after the credential lapsed, the next write was replaced by `registrationExpired` and the `repoWrite` was not delivered. Run it with `slow: true`.

Everything else in the catalog passes against the reference, including the
identity-gated checks (foreign readers, writers' `notifyRepoUpdate`, foreign
authorities' credentials and revocations), the notification webhooks and the
managing-app checks.

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
