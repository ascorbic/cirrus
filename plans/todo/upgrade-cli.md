# Upgrade CLI (`upgrade-pds`)

- Status: Draft
- Date: 2026-11-28
- Scope: a new package, `upgrade-pds`, plus a project manifest exported from `@getcirrus/pds`
- Reference: `upgrade-emdash` in `emdash-cms/emdash` (`packages/upgrade-emdash`)

## Summary

`npx upgrade-pds@latest`, run in a Cirrus project, does two things:

1. Bumps the project's direct `@getcirrus/*` dependencies to an npm dist-tag and installs them.
2. Writes `.cirrus/UPGRADE.md`, a work order for everything installation cannot do: the release entries crossed, the gaps between the project and what the installed PDS expects of it, and the build, deploy and verify commands.

It does not edit `wrangler.jsonc` or the worker entry, set secrets, or deploy. The work order is the handoff to a coding agent or the project owner.

Today the same job is the manual procedure in `docs/src/content/docs/guides/update.md`: bump, read two changelogs, hope you spot the line that says to add a binding. The 0.19.0 release shows the failure mode. It needed two new Durable Object bindings, a `v2` migration, two new re-exports and an R2 lifecycle rule, and the changelog entry mentions only the last of those.

## What carries over from upgrade-emdash, and what doesn't

Carries over nearly unchanged:

- Project discovery, package manager detection, install command selection.
- Specifier handling: preserve caret, tilde or exact style; a preview URL or git source becomes a caret range.
- Registry resolution by dist-tag (`--to next`), refusing exact versions and downgrades.
- Changelog fetch from the exact release tag on GitHub, Changesets wrapper stripping, removal of `Updated dependencies` entries, deduplication across packages. Cirrus uses the same `@changesets/changelog-github` format and the same `<name>@<version>` tags.
- Flags: `--cwd`, `--to`, `--dry-run`, `--json`, `--yes`.
- The plan/apply split: build a full plan with no side effects, print it, confirm, apply.

Dropped:

- pnpm catalog and workspace handling. A Cirrus project is the single-package scaffold from `create-pds`. `catalog:`, `workspace:`, `link:`, `file:` and `npm:` specifiers are reported and left alone.
- Skills sync. Cirrus has no skills repository.
- Changelog archive markers. Cirrus changelogs are single files.

Different:

- **Transitive Cirrus packages.** A project depends on `@getcirrus/pds` only; `@getcirrus/oauth-provider` and `@getcirrus/spaces` arrive through it, and the PDS changelog records their changes as bare `Updated dependencies` lines. The plan reads the `dependencies` of `@getcirrus/pds` at the from and to versions from the registry (`workspace:*` publishes as an exact version), and fetches those packages' changelog ranges too.
- **Project manifest instead of migration identity.** EmDash compares core migration names before and after install. Cirrus has no user-run database migrations: Durable Object SQLite schemas migrate themselves on first use. What changes between releases is the contract with the host project. See below.
- **Deployed version.** A Cirrus project has a live deployment whose version is one HTTP request away.

## The project manifest

`@getcirrus/pds` gains a second export, `@getcirrus/pds/manifest`: a JSON-serialisable description of what the package requires from the project that hosts it.

```ts
interface ProjectManifest {
	version: string;
	requirements: Requirement[];
}

type Requirement = (
	| { kind: "export"; name: string }
	| { kind: "durable-object"; binding: string; className: string; sqlite: true }
	| { kind: "r2-bucket"; binding: string }
	| { kind: "var"; name: string }
	| { kind: "secret"; name: string }
	| { kind: "compatibility-flag"; flag: string }
	| { kind: "compatibility-date"; minimum: string }
	| { kind: "peer"; name: string; range: string }
	| { kind: "manual"; id: string; instructions: string }
) & {
	/** Omitted for requirements every project must meet. */
	feature?: "blobs" | "spaces" | "sessions";
	since: string;
	docs?: string;
};
```

`manual` covers work that cannot be checked from the project directory, such as the R2 lifecycle rule for staged blobs or running `pds spaces kem`.

After install, the updater loads the manifest from the project's `node_modules` in a child process (the way upgrade-emdash loads `emdash/migrations`) and checks each requirement against the project:

| Kind | Check |
| --- | --- |
| `export` | The file named by `main` in the wrangler config exports the name (regex over `export { … }` and `export *`; reported as unverified when the entry is not a plain re-export) |
| `durable-object` | A binding with that name and class exists, and some migration lists the class in `new_sqlite_classes` |
| `r2-bucket` | A binding with that name exists |
| `var` | Present and non-empty in `vars` |
| `secret` | Not checkable locally; listed with the `pds secret` command that sets it |
| `compatibility-flag`, `compatibility-date` | Read from the wrangler config |
| `peer` | Installed version satisfies the range |
| `manual` | Listed when `since` is later than the from version |

The check is against the project as it stands, not a before/after diff of two manifests. That catches drift from earlier manual upgrades (a project already on 0.19.0 that never added the space classes) and works when the from version predates the manifest.

Feature-scoped requirements are checked when the feature is in use (`SPACES_ENABLED` is `"true"`, a `BLOBS` binding exists) and otherwise listed under "available features" with their docs link, so the work order does not push anyone to adopt spaces.

Reading the wrangler config uses `jsonc-parser`, not wrangler's own reader, so the updater has no dependency on the project's wrangler version. `wrangler.toml` projects get the requirements listed unchecked.

### Keeping the manifest honest

A test in `packages/pds` asserts three things agree:

- every `export` requirement is a real export of `src/index.ts`, and every exported Durable Object class has one;
- `packages/create-pds/templates/pds-worker/wrangler.jsonc` and `src/index.ts` satisfy every requirement with all features on;
- the env validation list in `src/index.ts` and the `var`/`secret` requirements name the same keys.

The checker itself lives in `upgrade-pds`. The pds test imports it as a workspace devDependency, so the template and the checker are tested against each other in one place.

## The work order

`.cirrus/UPGRADE.md`, with these sections:

1. **Package changes.** Each direct package: from → to, specifier before and after. Transitive Cirrus packages listed with their resolved versions.
2. **Deployment.** The version reported by `https://<PDS_HOSTNAME>/xrpc/_health`, when `PDS_HOSTNAME` is set and the request succeeds. When production is behind the installed version, the changelog range starts from the deployed version, since that is what the deploy will cross.
3. **Project changes required.** One item per unmet requirement, with the exact binding, class, export or var missing, the file it belongs in, and the docs link. Durable Object items state that migration tags are append-only and name the next free tag in this project's config.
4. **Manual steps.** `manual` requirements crossed by this upgrade, and unverifiable `secret` requirements added since the from version.
5. **Release entries to assess.** Full authored entries, grouped as in upgrade-emdash, with `Applies to` and source PR.
6. **Build, deploy, verify.** `build`, `pds status --dev` against `dev`, `deploy`, then `pds status`. Rollback: reinstall the from version and redeploy, with the caveat that Durable Object storage migrations and deployed class migrations do not roll back.
7. **Available features.** Feature-scoped requirements not in use.

`--json` emits the pre-install plan; requirement checks are in the JSON only when the installed version already ships a manifest.

## Package layout

`packages/upgrade-pds`, published unscoped next to `create-pds` (`upgrade-pds` is free on npm):

```
src/
  index.ts        citty command, clack prompts, plan → confirm → apply
  project.ts      root discovery, package manager, installed versions, install
  registry.ts     dist-tag and version metadata, transitive @getcirrus deps
  changelog.ts    fetch, parse, range, dedupe
  manifest.ts     load installed manifest in a child process
  requirements.ts check requirements against wrangler config and worker entry
  plan.ts         assemble UpgradePlan
  guide.ts        render UPGRADE.md
  types.ts
test/
```

Matches the repo: tsdown, vitest, citty, `@clack/prompts`, prettier with tabs. Dependencies: `citty`, `@clack/prompts`, `picocolors`, `semver`, `jsonc-parser`. Network access is an injected `fetch` in every function that uses it.

A standalone `npx` package, not a `pds upgrade` subcommand: the subcommand that would run is the one from the version being upgraded away from, so fixes to the updater would never reach the projects that need them.

The generic modules are ported from upgrade-emdash by copy. A shared library across two repositories is not justified by two consumers.

## Implementation order

Each step is test-first.

1. **Manifest in `@getcirrus/pds`.** Types, the manifest for the current release (core, blobs, sessions, spaces, with accurate `since` values from the changelog), the `./manifest` export, and the consistency test. Changeset: minor, user-facing wording.
2. **`upgrade-pds` skeleton.** Package, args, project discovery, registry resolution, dependency plan, `--dry-run` and `--json`. Tests use temp-dir fixture projects and a stub fetch.
3. **Changelog.** Port the parser and range logic; add transitive package resolution. Fixture: the real `@getcirrus/pds` changelog across 0.17.1 → 0.19.0, asserting the oauth-provider and spaces entries appear.
4. **Requirement checks.** One test per kind, plus fixtures for a pre-spaces project (the 0.18-era template) and a current one.
5. **Apply and guide.** Write package.json, install, verify installed versions match the plan, load the manifest, render the work order. Restore package.json and the lockfile when install fails.
6. **Deployed version lookup.**
7. **Docs.** Rewrite `guides/update.md` around the command, keeping the manual procedure as a fallback; add a line to the template README; add `.cirrus/` to the template `gitignore`.
8. **End-to-end test.** Scaffold with `create-pds` at an older pinned PDS version, run `upgrade-pds --yes`, assert the work order names the missing space bindings.

## Open questions

- **Name.** `upgrade-pds` pairs with `create-pds`. `upgrade-cirrus` is the alternative if the unscoped `-pds` name reads as too generic.
- **Applying mechanical fixes.** Adding a binding, a migration tag and a re-export is deterministic, and `experimental_patchConfig` is already used by `pds init`. A later `--fix` could apply `durable-object`, `r2-bucket` and `export` items. Left out of the first version because a deployed Durable Object migration cannot be undone, and a wrong tag in a hand-edited config is worse than an unticked item in a work order.
- **First publish.** The release workflow publishes through Changesets with OIDC. A new unscoped package name needs its trusted publisher configured on npm before the first automated release.
