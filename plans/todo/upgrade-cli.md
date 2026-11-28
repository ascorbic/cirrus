# Upgrade CLI (`upgrade-pds`)

- Status: Draft
- Date: 2026-11-28
- Scope: a new package, `upgrade-pds`
- Reference: `upgrade-emdash` in `emdash-cms/emdash` (`packages/upgrade-emdash`)

## Summary

`npx upgrade-pds@latest`, run in a Cirrus project, does two things:

1. Bumps the project's direct `@getcirrus/*` dependencies to an npm dist-tag and installs them.
2. Writes `.cirrus/UPGRADE.md`, a work order containing every authored release entry the upgrade crosses, a pointer to the reference project for the target version, and the build, deploy and verify commands.

It does not edit `wrangler.jsonc` or the worker entry, set secrets, or deploy. The work order is the handoff to a coding agent or the project owner.

The updater does not model what a release requires of a project. There is no manifest, no requirement schema and no config checker. The release entries are the source of truth, and the agent reading them decides what applies. The work this plan asks of Cirrus itself is therefore mostly editorial: entries have to say what a project owner must change.

## What carries over from upgrade-emdash

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
- Migration identity. Durable Object SQLite schemas migrate themselves on first use; there is nothing for the project owner to apply.

## What is different

**Transitive Cirrus packages.** A project depends on `@getcirrus/pds` only. `@getcirrus/oauth-provider` and `@getcirrus/spaces` arrive through it, and the PDS changelog records their changes as bare `Updated dependencies` lines. The plan reads the `dependencies` of `@getcirrus/pds` at the from and to versions from the registry (`workspace:*` publishes as an exact version) and fetches those packages' changelog ranges too.

**Reference project link.** The work order links to `packages/create-pds/templates/pds-worker` at the target release tag, and tells the agent to compare the project's `wrangler.jsonc`, worker entry and `vite.config.ts` against it when a release entry mentions project configuration. The updater does not fetch or diff the template.

## The work order

`.cirrus/UPGRADE.md`:

1. **Package changes.** Each direct package: from → to, specifier before and after. Transitive Cirrus packages listed with their resolved versions.
2. **Release entries to assess.** Full authored major, minor and patch entries crossed, with `Applies to` and source PR, as in upgrade-emdash. The instruction is the same: check whether each entry affects this project, and do not adopt an unrelated feature because it appears here.
3. **Reference project.** The template link at the target tag.
4. **Build, deploy, verify.** `build`, `dev` with `pds status --dev`, `deploy`, then `pds status`. Durable Object migration tags are append-only. Rollback is reinstalling the from version and redeploying; storage migrations and deployed class migrations do not roll back.

`--json` emits the pre-install plan.

## Release entries have to carry the instructions

With no structured layer, an entry that omits a required project change is a broken upgrade. The 0.19.0 entry is the example: the release needed two Durable Object bindings, a `v2` migration, two re-exports from the worker entry and an R2 lifecycle rule, and the entry mentions only the lifecycle rule.

- `AGENTS.md` gains a changeset rule: when a change requires anything of an existing project (wrangler config, worker entry, vars, secrets, a CLI command to run, a dashboard or R2 setting), the changeset says exactly what, in imperative terms, with the config snippet.
- The 0.19.0 entry in `packages/pds/CHANGELOG.md` is corrected to list the bindings, migration and re-exports. The updater reads the changelog at the target tag, so the corrected text reaches everyone upgrading to the next release or later.
- The same pass covers earlier entries that required project changes (data placement in #104, blob staging in #208).

## Package layout

`packages/upgrade-pds`, published unscoped next to `create-pds` (`upgrade-pds` is free on npm):

```
src/
  index.ts      citty command, clack prompts, plan → confirm → apply
  project.ts    root discovery, package manager, installed versions, install
  registry.ts   dist-tag and version metadata, transitive @getcirrus deps
  changelog.ts  fetch, parse, range, dedupe
  plan.ts       assemble UpgradePlan
  guide.ts      render UPGRADE.md
  types.ts
test/
```

Matches the repo: tsdown, vitest, citty, `@clack/prompts`, prettier with tabs. Dependencies: `citty`, `@clack/prompts`, `picocolors`, `semver`, `jsonc-parser` (format-preserving `package.json` edits). Network access is an injected `fetch` in every function that uses it.

A standalone `npx` package, not a `pds upgrade` subcommand: the subcommand that would run is the one from the version being upgraded away from, so fixes to the updater would never reach the projects that need them.

The generic modules are ported from upgrade-emdash by copy.

## Implementation order

Each step is test-first.

1. **Skeleton.** Package, args, project discovery, registry resolution, dependency plan, `--dry-run` and `--json`. Tests use temp-dir fixture projects and a stub fetch.
2. **Changelog.** Port the parser and range logic; add transitive package resolution. Fixture: the real `@getcirrus/pds` changelog across 0.17.1 → 0.19.0, asserting the oauth-provider and spaces entries appear.
3. **Apply and guide.** Write `package.json`, install, verify installed versions match the plan, render the work order. Restore `package.json` and the lockfile when install fails.
4. **Changelog corrections and the `AGENTS.md` rule.**
5. **Docs.** Rewrite `guides/update.md` around the command, keeping the manual procedure as a fallback; add a line to the template README; add `.cirrus/` to the template `gitignore`.
6. **End-to-end test.** Scaffold with `create-pds` at an older pinned PDS version, run `upgrade-pds --yes`, assert the dependency moved and the work order contains the crossed entries.

## Open questions

- **Name.** `upgrade-pds` pairs with `create-pds`. `upgrade-cirrus` is the alternative if the unscoped `-pds` name reads as too generic.
- **First publish.** The release workflow publishes through Changesets with OIDC. A new unscoped package name needs its trusted publisher configured on npm before the first automated release.
