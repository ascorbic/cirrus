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

The `.cirrus` directory gets its own `.gitignore`, so the work order stays out of the project's repository.

The updater does not edit `wrangler.jsonc` or the worker source, set secrets, or deploy. Give the work order to a coding agent or work through it yourself, then deploy.

## Options

```sh
npx upgrade-pds@latest --dry-run   # show the plan without changing files
npx upgrade-pds@latest --json      # print the plan as JSON without changing files
npx upgrade-pds@latest --yes       # apply without the confirmation prompt
npx upgrade-pds@latest --to next   # install another npm dist-tag
npx upgrade-pds@latest --cwd ./pds # run against another directory
npx upgrade-pds@latest --from 0.18.0 # cover releases after an earlier version
```

`--to` takes a dist-tag, not a version.

## Requirements

- The project declares `@getcirrus/pds` as a direct dependency.
- Dependencies are installed, so the updater can read the versions in `node_modules`. Yarn Plug'n'Play installs are not supported; set `nodeLinker: node-modules` in `.yarnrc.yml` first.

Packages declared with `workspace:`, `catalog:`, `link:`, `file:`, `portal:`, `patch:`, or `npm:` specifiers, or a bare local path, are reported and left unchanged. So is a direct Cirrus package other than `@getcirrus/pds` that has no release on the chosen dist-tag.

If the install fails or is interrupted, `package.json`, the lockfile, and any earlier work order are restored and the previous dependencies are reinstalled.

The work order covers the versions installed when the updater ran. Once the packages have moved, running the updater again reports that nothing needs to change and leaves the existing work order in place.

## Projects that were already updated

If `@getcirrus/pds` was bumped by hand, or the work order was lost, pass the version the project was on before:

```sh
npx upgrade-pds@latest --from 0.18.0
```

The work order then covers every release after that version. Packages already on the target release are left as they are, and anything still behind is updated as usual. `--from` takes an exact `@getcirrus/pds` version that is not newer than the installed one. Use the version from the project's last deploy; `git log -p package.json` shows earlier values.
