# Rename: @getcirrus/cirrus → @fidis/fid.is

## Context

The project was forked from `ascorbic/cirrus` (a generic single-user AT Protocol PDS) and has evolved into a Farcaster-specific multi-tenant service (WebFID) deployed at `fid.is`. The "Cirrus" name no longer reflects what this project is. The rename aligns the codebase identity with the product: **fid.is**.

**Decisions:**
- NPM scope: `@getcirrus` → `@fidis`
- Root package name: `cirrus` → `fidis`
- GitHub repo: `cboscolo/cirri` → `cboscolo/fidis`
- Brand (user-facing): `fid.is`
- npm publishing: not needed (private only)

---

## Changes

### 1. Package names (package.json `"name"` fields)

| File | Old | New |
|------|-----|-----|
| `package.json` (root) | `cirrus` | `fidis` |
| `packages/pds/package.json` | `@getcirrus/pds` | `@fidis/pds` |
| `packages/oauth-provider/package.json` | `@getcirrus/oauth-provider` | `@fidis/oauth-provider` |
| `packages/create-pds/` | — | **DELETE** (no longer relevant to fid.is) |
| `apps/miniapp/package.json` | `@getcirrus/miniapp` | `@fidis/miniapp` |
| `apps/signup/package.json` | `@getcirrus/signup` | `@fidis/signup` |
| `apps/sync/package.json` | `@getcirrus/sync` | `@fidis/sync` |
| `apps/fid-pds/package.json` | check name | `@fidis/fid-pds` |
| `demos/pds/package.json` | check name | `@fidis/demo-pds` |

### 2. Workspace dependency references

Replace `@getcirrus/*` with `@fidis/*` in all `dependencies`/`devDependencies`:

- `packages/pds/package.json` → `@fidis/oauth-provider` dep
- `apps/fid-pds/package.json` → `@fidis/pds` dep
- `demos/pds/package.json` → `@fidis/pds` dep
- `packages/pds/e2e/fixture/package.json` → `@fidis/pds` template reference
- Root `package.json` → filter scripts referencing `@getcirrus/*`

### 3. Delete `packages/create-pds/`

Remove the entire `packages/create-pds/` directory — it's a CLI scaffolding tool for the original Cirrus project and is not relevant to fid.is.

### 4. Import statements in source code

Global find-replace `@getcirrus/` → `@fidis/` in all `.ts` files:

- `packages/pds/src/oauth.ts` — imports `@getcirrus/oauth-provider`
- `packages/pds/src/account-do.ts` — imports `@getcirrus/oauth-provider`
- `packages/pds/src/passkey.ts` — imports `@getcirrus/oauth-provider`
- `packages/pds/src/oauth-storage.ts` — imports `@getcirrus/oauth-provider`
- `packages/pds/src/cli/utils/cli-helpers.ts` — imports `@getcirrus/oauth-provider`
- `packages/pds/src/cli/commands/identity.ts` — imports `@getcirrus/oauth-provider`
- `apps/fid-pds/src/index.ts` — re-exports `@getcirrus/pds`
- `demos/pds/src/index.ts` — re-exports `@getcirrus/pds`

### 5. User-facing brand strings

| File | Old | New |
|------|-----|-----|
| `packages/pds/src/oauth.ts` (line ~296) | `Cirrus Authorization` | `fid.is Authorization` |
| `packages/pds/src/oauth.ts` | `Cirrus PDS authorization page` | `fid.is authorization page` |
| `packages/pds/src/oauth.ts` | `Cirrus Authorization` (og:title) | `fid.is Authorization` |

### 6. GitHub repository URLs

Replace `github.com/ascorbic/cirrus` → `github.com/cboscolo/fidis` in:

- `packages/pds/package.json` — `repository.url`, `homepage`
- `packages/oauth-provider/package.json` — same
- `.changeset/config.json` — `"repo": "ascorbic/cirrus"` → `"cboscolo/fidis"`
- `packages/pds/src/cli/commands/init.ts` — GitHub link in help text

### 7. CHANGELOG files

- `packages/pds/CHANGELOG.md` — references to `github.com/ascorbic/cirrus`
- `packages/oauth-provider/CHANGELOG.md` — same

Decision: leave CHANGELOG URLs as-is — they are historical references to the upstream repo.

### 8. Documentation

| File | Changes |
|------|---------|
| `README.md` | Replace "CIRRUS" heading, "Cirrus is..." description, `@getcirrus/*` references |
| `BRAND.md` | Rewrite — replace "Cirrus" brand guidance with "fid.is" |
| `CLAUDE.md` | Replace `cirrus` root reference, `@getcirrus/*` package names |
| `packages/pds/README.md` | "# Cirrus" → "# fid.is PDS", `@getcirrus/pds` refs |
| `packages/oauth-provider/README.md` | `@getcirrus/oauth-provider` refs |
| `demos/pds/README.md` | `@getcirrus/pds` refs |
| `apps/fid-pds/README.md` | `@getcirrus/pds` refs |
| `plans/complete/oauth-provider.md` | `@getcirrus/oauth-provider` refs |

### 9. CI/CD & config

- `.github/workflows/e2e.yml` — `--filter @getcirrus/pds` → `--filter @fidis/pds`
- `.changeset/config.json` — repo name

### 10. Lock file & node_modules

After all renames:
1. Delete `node_modules` and `pnpm-lock.yaml`
2. Run `pnpm install` to regenerate

### 11. GitHub repo rename

Manual step (not in code):
1. Rename `cboscolo/cirri` → `cboscolo/fidis` on GitHub Settings
2. Update git remote: `git remote set-url origin git@github.com:cboscolo/fidis.git`
3. Update upstream if desired: `git remote set-url upstream git@github.com:ascorbic/cirrus.git` (keep pointing to original)

---

## Execution order

1. Delete `packages/create-pds/` entirely
2. Package names (`package.json` name fields) — all at once
3. Workspace deps (`package.json` dependency fields) — all at once
4. Source imports — global `@getcirrus/` → `@fidis/` replace
5. Brand strings — `Cirrus` → `fid.is` in OAuth HTML
6. GitHub URLs — bulk replace `ascorbic/cirrus` → `cboscolo/fidis`
7. Documentation — README, BRAND.md, CLAUDE.md
8. CI/CD config — workflows, changeset config
9. `rm -rf node_modules pnpm-lock.yaml && pnpm install`
10. Type-check: `tsc --noEmit` in each package
11. Run tests: `pnpm test`
12. GitHub repo rename (manual, after commit)

## Verification

1. `pnpm install` succeeds with no resolution errors
2. `pnpm build` succeeds across all packages
3. `pnpm check` passes (type-checking + publint)
4. `grep -r "getcirrus" --include="*.ts" --include="*.json" --include="*.md"` returns zero results (excluding CHANGELOG history and pnpm-lock.yaml)
5. `grep -r "Cirrus" --include="*.ts" --include="*.md"` returns zero results (excluding CHANGELOGs)
6. Dev servers start: `pnpm --filter @fidis/pds dev`, `pnpm --filter signup dev`
