---
title: create-pds CLI
description: Flags and behaviour of the create-pds scaffolder.
---

`create-pds` scaffolds a new Cirrus PDS project. It is published as the `create-pds` npm package and invoked via the standard `npm create` (or equivalent for other package managers).

## Invoke

```bash
npm create pds@latest [project-directory] [flags]
```

Or with pnpm / yarn / bun:

```bash
pnpm create pds@latest
yarn create pds
bun create pds
```

The optional `project-directory` argument sets the folder name. If omitted, the scaffolder prompts.

## What it does

1. Prompts for the project folder name, package manager, and whether to initialise a git repository.
2. Copies the `pds-worker` template into the folder.
3. Renames `gitignore` to `.gitignore` and substitutes template variables (`{{name}}`, `{{pdsVersion}}`).
4. Installs dependencies using the chosen package manager.
5. Runs `pds init` to start the setup wizard.

The generated project includes:

- `package.json` with scripts for `dev`, `deploy`, and `pds`.
- `wrangler.jsonc` with the Durable Object binding, R2 bucket, and Vars pre-configured.
- `.env.example` template for secrets.
- `vite.config.ts` for local dev.
- `src/index.ts` that re-exports the `@getcirrus/pds` Worker.
- A starter `README.md`.

## Flags

| Flag | Effect |
|---|---|
| `--package-manager <pm>`, `--pm <pm>` | Choose `pnpm`, `npm`, `yarn`, or `bun` without prompting. |
| `--skip-install` | Skip the dependency install step. |
| `--skip-git` | Skip `git init`. |
| `--skip-init` | Skip running `pds init` at the end. The project is scaffolded but not configured. |
| `--yes`, `-y` | Accept all defaults. Non-interactive. |

Example for a fully unattended scaffold:

```bash
npm create pds@latest my-pds -- --yes --pm pnpm --skip-init
```

`--skip-init` is useful in scripted setups that handle the wizard separately.

## After scaffolding

The generated project is a regular Cloudflare Workers project that depends on `@getcirrus/pds`. All ongoing operations use the `pds` CLI from inside the generated project — see [pds CLI](/reference/pds-cli/).
