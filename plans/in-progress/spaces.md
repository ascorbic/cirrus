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

## Not done / next

- **Interop runs** against the reference alpha Docker image and rsky.
  bulletin.my's S1 flow is verified live against pds.mk.gg (2026-08-29):
  OAuth with space: scopes, board space creation, delegation →
  credential exchange, reads, registerNotify and listRepos all work.
  Cross-PDS (S2–S4) remains unexercised against a real foreign PDS.
- **R2 lifecycle rule** must be applied per-install
  (`wrangler r2 bucket lifecycle add pds-blobs --prefix "<did>/staged/" --expire-days 7`);
  `pds init` doesn't automate it yet.
- Streaming `getRepo` (currently buffers via `serializeRepo`), blob cache
  tagging, per-credential rate limits, import — all "Later" per the spec.
- Standalone host package (S9): the engine boundary is in place; no
  package yet.
- Alpha deps (`@atproto/space`, `@atproto/oauth-scopes` at
  `0.0.0-spaces-alpha-20260818163953`) need re-verification against each
  upstream Thursday build; Renovate is configured to leave them alone.

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
  oauth-provider defines the shape locally.
- Deleted spaces read as `SpaceNotFound`, never-written spaces as
  `RepoNotFound`; `getSpaceCredential` alone answers `SpaceDeleted`
  (tombstone retained in the space DO).
