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
- A `must` check the reference **fails** is either a real gap in the alpha
  reference or an over-specification in our check. Each such case is pinned and
  cited in [`test/reference-matrix.test.ts`](test/reference-matrix.test.ts),
  so "the reference fails this" is a reviewed fact, not a surprise.

The test pins the **whole partition**: which checks pass, which diverge, which
skip. If a passing check regresses, CI fails. If a pinned divergence starts
_passing_ — the reference caught up, or a check quietly weakened — CI also
fails, forcing the list to be re-examined. The matrix is only worth having if
it cannot silently rot.

## Pinned reference divergences (alpha `0.0.0-spaces-alpha-20260818163953`)

| Check                          | Why the reference diverges                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery.space-host-service` | Reference is multi-tenant did:plc; it serves no DID document at `${origin}/.well-known/did.json`, so the space-host service entry can't be read there.                                                                                                                                                                                                         |
| `discovery.verification-key`   | Same: no DID document at the origin.                                                                                                                                                                                                                                                                                                                           |
| `blobs.space-blob-not-public`  | Reference refuses an unreferenced upload on public `sync.getBlob`, but a space-record reference promotes the blob to public availability as a public reference would — the private write leaks the bytes. Proposal 0016 §blob-sync intends space blobs to be fetched via the credential-gated `space.getBlob`; Cirrus enforces it with a per-space key layout. |

The identity-gated checks (foreign reader/writer DIDs) skip here because the
reference can't resolve harness identities; they run in-process against the
`@getcirrus/spaces` fixture adapter, which wires a did:key resolver. The
operator's own credential flow is still covered end-to-end by
`credential.self-round-trip`.

## Running

```bash
pnpm --filter @getcirrus/space-conformance-matrix test
```

`@getcirrus/space-conformance` must be built first (`pnpm build`), which CI
does before `pnpm test`. The reference stack pulls `better-sqlite3` (a native
module) and the `@atproto/lex*` family, which the spaces alpha published with
leaked `workspace:*` specifiers — both are handled by `pnpm-workspace.yaml`
(`allowBuilds` and `overrides` respectively).
