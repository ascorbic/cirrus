# upgrade-pds

Upgrade a [Cirrus](https://github.com/ascorbic/cirrus) PDS project and write down the work that installing packages cannot do.

Run the latest updater from the project directory:

```sh
npx upgrade-pds@latest
```

The updater resolves the `latest` npm dist-tag for every `@getcirrus/*` package the project depends on directly, shows the plan, and asks for confirmation. It then updates `package.json`, keeping each caret, tilde, or exact version style, runs the project's package manager, and writes `.cirrus/UPGRADE.md`.

The work order contains:

- the package versions that changed, including the Cirrus packages installed through `@getcirrus/pds`
- every authored major, minor, and patch release entry crossed by the update, fetched from each package's changelog at its release tag
- a link to the `create-pds` project template at the target release
- the build, deploy, and verification commands for the project's package manager

The updater does not edit `wrangler.jsonc` or the worker source, set secrets, or deploy. Give the work order to a coding agent or work through it yourself, then deploy.

## Options

```sh
npx upgrade-pds@latest --dry-run   # show the plan without changing files
npx upgrade-pds@latest --json      # print the plan as JSON without changing files
npx upgrade-pds@latest --yes       # apply without the confirmation prompt
npx upgrade-pds@latest --to next   # install another npm dist-tag
npx upgrade-pds@latest --cwd ./pds # run against another directory
```

`--to` takes a dist-tag, not a version.

## Requirements

- The project declares `@getcirrus/pds` as a direct dependency.
- Dependencies are installed, so the updater can read the versions in `node_modules`. Yarn Plug'n'Play installs are not supported; set `nodeLinker: node-modules` in `.yarnrc.yml` first.

Packages declared with `workspace:`, `catalog:`, `link:`, `file:`, `portal:`, or `npm:` specifiers are reported and left unchanged.

If the install fails, `package.json` and the lockfile are restored and the previous dependencies are reinstalled.
