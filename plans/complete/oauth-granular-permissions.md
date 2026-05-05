# Granular OAuth Permissions

**Status:** ✅ Complete (Phase 1 + Phase 2)
**Packages:** `@getcirrus/oauth-provider`, `@getcirrus/pds`

## Goal

Support the atproto granular permission spec ([spec](https://atproto.com/specs/permission), [permission sets guide](https://atproto.com/guides/permission-sets)) so clients can request `repo:`, `rpc:`, `blob:`, `account:`, `identity:`, and `include:` scopes instead of (or alongside) the legacy `transition:*` scopes.

The PDS currently advertises only `atproto`, `transition:generic`, `transition:chat.bsky` and matches scopes via a naive `scopes.includes(requiredScope)` string compare. That can't express per-collection write rights, per-aud RPC limits, or permission set bundles.

## Spec recap (just enough to design against)

Scope syntax: `resource:positional?param=value&param=value` (parameters can repeat for arrays).

| Resource   | Positional | Other params                          | Notes                                              |
| ---------- | ---------- | ------------------------------------- | -------------------------------------------------- |
| `repo`     | collection | `action` (create/update/delete)       | `*` wildcard allowed in scope strings              |
| `rpc`      | lxm        | `aud`, `inheritAud` (sets only)       | `*` allowed; can't wildcard both lxm and aud       |
| `blob`     | accept     | —                                     | MIME pattern, `*/*` allowed                        |
| `account`  | attr       | `action` (read/manage)                | attrs: `email`, `repo`                             |
| `identity` | attr       | —                                     | attrs: `handle`, `*`                               |
| `include`  | nsid       | `aud`                                 | Expands to permissions from a lexicon perm-set     |

Permission sets are Lexicon docs (`type: permission-set`) referenced by NSID; auth servers resolve them dynamically and cache. Sets can only reference resources within their own NSID hierarchy.

## Library choices

Stack on top of two upstream libs — both workers-compatible, both already in cirrus's preferred ecosystem:

- **`@atproto/oauth-scopes`** (v0.3.2, deps: `@atproto/did`, `@atproto/syntax`) — `ScopesSet`, `ScopePermissions`, `IncludeScope`. Pure parsing/matching. No atcute equivalent exists yet.
- **`@atcute/lexicon-resolver`** (v0.1.6, ~38KB) — isomorphic permission-set lexicon resolution via `@atcute/repo` + `@atcute/util-fetch`. Matches the project's existing atcute lean.

Bump `@atproto/oauth-types` from 0.5.2 → 0.6.3 at the same time (carries the granular metadata fields).

## Phased rollout

### Phase 1 — Granular scope parsing & enforcement (no permission sets)

Smallest shippable step. Bluesky shipped granular scopes before permission sets, and most apps in the wild still use string scopes.

1. **Add deps** to `packages/oauth-provider`:
   - `@atproto/oauth-scopes@^0.3.2`
   - bump `@atproto/oauth-types` to `^0.6.3`

2. **Replace scope parsing** in `provider.ts`:
   - Accept any well-formed scope string at `/oauth/authorize` and PAR; reject `include:` for now with `invalid_scope`.
   - Internally hold scopes as `ScopesSet` (not `string`), but keep the **stored** value as the original space-separated string in `AuthCodeData.scope` and `TokenData.scope` (no schema change to `oauth_auth_codes` / `oauth_tokens`).

3. **Redesign `verifyAccessToken`** signature in `provider.ts:772`:
   ```ts
   verifyAccessToken(
     request: Request,
     check?: (perms: ScopePermissions) => void,
   ): Promise<TokenData | null>
   ```
   - Replaces the current `requiredScope?: string` parameter.
   - Callers pass `(p) => p.assertRepo({ collection: "app.bsky.feed.post", action: "create" })` or similar; `assert*` throws `ScopeMissingError` and we return null.
   - For backward compat with `transition:generic` callers, accept it as a string overload that maps to "any non-include scope present".

4. **Update advertised metadata** in `provider.ts:739`:
   - `scopes_supported` = `["atproto", "transition:generic", "transition:chat.bsky", "repo", "rpc", "blob", "account", "identity"]`. The granular ones don't take values in the metadata list — clients still send full strings like `repo:app.bsky.feed.post`.

5. **Consent UI** (`ui.ts:198`):
   - Replace the hardcoded switch in `getScopeDescriptions` with iteration over `ScopesSet` rendering per-resource human strings (e.g. "Create posts in app.bsky.feed.post", "Call app.bsky.feed.getTimeline on api.bsky.app").
   - Group by resource type for readability.

6. **PDS integration** — three callsites:
   - `packages/pds/src/middleware/auth.ts:37` — `requireAuth` doesn't currently scope-check; it just stashes `tokenData.scope` on context. Leave that intact, but add an optional `requireAuth({ scope: ... })` factory variant for routes that need granular checks.
   - `packages/pds/src/oauth.ts:245` — userinfo endpoint, no scope check needed.
   - `packages/pds/src/xrpc-proxy.ts:152` — when forwarding to AppView, gate per-`lxm` against `rpc` scopes (with the AppView's DID as `aud`); fall back to `transition:generic` if any of those is held.

7. **Per-endpoint enforcement** in `packages/pds/src/index.ts`:
   - `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` — assert `repo` permission for the collection in the request body.
   - `com.atproto.repo.uploadBlob` — assert `blob` for the request's content-type.
   - `com.atproto.server.updateEmail` — assert `account:email?action=manage`.
   - Account-mgmt endpoints (deactivate/activate/delete) — assert `account:repo?action=manage`.
   - Always treat `transition:generic` as "permits everything except `account:*`" for back-compat (matches Bluesky's transitional behavior).

8. **Tests** in `packages/oauth-provider/test/`:
   - New `scopes.test.ts` exercising the wrapper around `@atproto/oauth-scopes` (round-trip parse, `verifyAccessToken` with check callback, transitional-scope back-compat).
   - Extend `oauth-flow.test.ts` to cover a granular-scope authorize → token → resource-server check flow.

**Phase 1 exit criteria:** Cirrus accepts and enforces granular scope strings. Apps using `transition:generic` still work unchanged. `include:` is rejected with a clear error.

### Phase 2 — Permission set resolution

Adds the `include:` resource and the lexicon-resolver integration.

1. **Add `@atcute/lexicon-resolver`** to `packages/oauth-provider`.

2. **Define a `PermissionSetResolver` interface** in `oauth-provider/src/permission-sets.ts`:
   ```ts
   interface PermissionSetResolver {
     resolve(nsid: string): Promise<LexiconPermissionSet | null>;
   }
   ```
   The provider package ships a default implementation that wraps `@atcute/lexicon-resolver`, but the PDS supplies its own that wraps the resolver in a cache layer.

3. **Cache layer** — DO SQLite in `packages/pds/src/oauth-storage.ts`:
   - New table `oauth_permission_sets` with `(nsid PRIMARY KEY, lexicon BLOB, fetched_at INTEGER, expires_at INTEGER)`.
   - Spec recommended TTLs: stale-after 24h, hard-expire 90d. Implement stale-while-revalidate: serve stale and kick off a background refresh via DO `ctx.waitUntil` on read.
   - Cache shared across all accounts on the DO (per spec).

4. **Expansion at authorize-time, not verify-time:**
   - When `/oauth/authorize` receives an `include:` scope, resolve the set and **expand inline** into the stored scope string before saving the auth code. This means tokens always carry concrete granular scopes; resource-server checks never need network access.
   - Trade-off: a cached permission set can change after token issue, but per the spec the cache TTL controls that — re-issued tokens pick up new perms; existing tokens keep the perms they were granted with.
   - Edge case: if resolution fails at authorize-time, fail the authorize request with `invalid_scope` rather than guessing.

5. **Audience inheritance** — handle `inheritAud: true` per spec when expanding RPC permissions.

6. **Consent UI** — when an `include:` is requested, render the permission set's `title`/`detail` (with i18n where present) instead of the expanded individual permissions, so users see the bundle name.

7. **Advertise** `include` in `scopes_supported` and add the corresponding metadata fields.

8. **Tests:**
   - Unit tests with a mock resolver (no network).
   - Integration test that authorizes with an `include:` scope, asserts the stored scope string is the expanded form, and verifies a request against the resulting token.
   - Cache-staleness test (returns stale, schedules refresh).

**Phase 2 exit criteria:** Clients can request `include:com.example.authBasicFeatures?aud=...` and the PDS correctly expands, displays, persists, and enforces the bundled permissions.

## Storage impact

| Change                             | Phase | Migration?          |
| ---------------------------------- | ----- | ------------------- |
| `AuthCodeData.scope` (string)      | 1     | None — stays string |
| `TokenData.scope` (string)         | 1     | None — stays string |
| New `oauth_permission_sets` table  | 2     | New table only      |

No destructive migrations. Existing tokens issued with `transition:*` continue to work.

## Out of scope

- Account-scoped operations like `account:email?action=manage` for password resets — only the few endpoints listed under Phase 1 step 7.
- Defining cirrus-owned permission sets as Lexicon docs (we only consume them in Phase 2).
- Removing the `transition:*` scopes — keep them indefinitely for back-compat; Bluesky does the same.

## Open questions

- Should `requireAuth` middleware infer scope requirements from the route (e.g. introspect the XRPC method NSID) instead of every route declaring its own check? Probably yes for proxy routes, no for the typed write endpoints — but worth a pass once Phase 1 lands.
- For the AppView proxy, do we want to check `rpc` scope **before** signing the service JWT, or always sign and let AppView reject? Checking first is stricter and gives better error messages; that's what Phase 1 step 6 assumes.
