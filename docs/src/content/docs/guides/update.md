---
title: Update a deployed PDS
description: Upgrade a running Cirrus deployment to a newer release of the PDS package.
---

Cirrus is published as `@getcirrus/pds` on npm. Updating means installing a newer release, making any project changes that release requires, and redeploying. `upgrade-pds` does the first part and writes down the second.

## Run the updater

From the project directory:

```bash
npx upgrade-pds@latest
```

The updater:

- resolves the `latest` npm release of every `@getcirrus/*` package the project depends on directly
- shows the versions it will change and asks for confirmation
- updates `package.json`, keeping each caret, tilde, or exact version style, and runs the project's package manager
- writes a work order to `.cirrus/UPGRADE.md`

It does not edit `wrangler.jsonc` or your worker source, set secrets, or deploy.

To see what would change without touching the project:

```bash
npx upgrade-pds@latest --dry-run
```

Other options:

| Option             | Effect                                                   |
| ------------------ | -------------------------------------------------------- |
| `--to <tag>`       | Install another npm dist-tag, such as `next`             |
| `--yes`            | Apply without the confirmation prompt                    |
| `--json`           | Print the plan as JSON without changing files            |
| `--cwd`            | Run against a project in another directory               |
| `--from <version>` | Cover releases after an earlier `@getcirrus/pds` version |

`--to` takes a dist-tag, not a version. Dependencies must already be installed, so the updater can read the versions in `node_modules`.

## Follow the work order

`.cirrus/UPGRADE.md` contains:

- the package versions that changed, including `@getcirrus/oauth-provider` and `@getcirrus/spaces`, which are installed through `@getcirrus/pds`
- every release entry between the old and new versions, in full
- a link to the project template for the new release, to compare your `wrangler.jsonc` and worker entry against
- the build, deploy, and verification commands for your package manager

Hand the file to a coding agent, or work through it yourself. Most entries need no action. An entry that requires a change to an existing project says what to change.

The work order is specific to one upgrade. Add `.cirrus` to `.gitignore` if your project does not already ignore it; projects scaffolded by a recent `create-pds` do.

## If the packages were already updated

The updater works out which releases to cover from the versions in `node_modules`. If `@getcirrus/pds` was bumped by hand, or `.cirrus/UPGRADE.md` was lost, tell it the version the project was on before:

```bash
npx upgrade-pds@latest --from 0.18.0
```

It writes a work order for every release after that version, and updates any package that is still behind.

## Test locally

```bash
pnpm dev
```

The Vite dev server starts the Worker locally on port 5173. Use `pds status --dev` and `pds passkey list --dev` to verify auth and the Durable Object still work as expected.

## Deploy

```bash
pnpm run deploy
```

This builds the worker and deploys it to Cloudflare. The Durable Object's storage is preserved. Existing sessions remain valid unless a release explicitly invalidates them (the changelog calls this out).

After deploy, run `pds status` against production to confirm the upgraded Worker is healthy.

## Roll back

If the new release is broken, roll back by pinning the previous version:

```bash
pnpm add @getcirrus/pds@<previous-version>
pnpm run deploy
```

The work order lists the previous version of each package. A Durable Object class migration that has been deployed stays deployed, and rolling back across a release that migrated storage may not work. The changelog flags this.

## Update by hand

The updater is a convenience. The same upgrade without it:

1. Check the installed version with `pnpm list @getcirrus/pds`.
2. Read the changelogs for [`@getcirrus/pds`](https://github.com/ascorbic/cirrus/blob/main/packages/pds/CHANGELOG.md), [`@getcirrus/oauth-provider`](https://github.com/ascorbic/cirrus/blob/main/packages/oauth-provider/CHANGELOG.md), and [`@getcirrus/spaces`](https://github.com/ascorbic/cirrus/blob/main/packages/spaces/CHANGELOG.md) from your version to the latest.
3. Run `pnpm update @getcirrus/pds --latest`.
4. Make the project changes the entries call for, then test and deploy as above.

## Updating the scaffolder

The scaffolder (`create-pds`) is a separate package. It does not need to be updated to update an existing deployment; `create-pds` is only used to scaffold a new project.

To use a newer scaffolder for a new project:

```bash
npm create pds@latest
```
