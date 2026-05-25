---
title: Update a deployed PDS
description: Upgrade a running Cirrus deployment to a newer release of the PDS package.
---

Cirrus is published as `@getcirrus/pds` on npm. The scaffolded project pins the version; updating means bumping the dependency and redeploying.

## Check the current version

From the project directory:

```bash
pnpm list @getcirrus/pds
```

Compare against the [releases on GitHub](https://github.com/ascorbic/cirrus/releases) or the [npm page](https://www.npmjs.com/package/@getcirrus/pds).

## Read the changelog

Before updating, read the changelog for breaking changes:

- [`@getcirrus/pds` CHANGELOG](https://github.com/ascorbic/cirrus/blob/main/packages/pds/CHANGELOG.md)
- [`@getcirrus/oauth-provider` CHANGELOG](https://github.com/ascorbic/cirrus/blob/main/packages/oauth-provider/CHANGELOG.md)

Cirrus follows semver while in beta, but the surface area is still in flux. Breaking changes are noted explicitly in the changelog.

## Update the dependency

```bash
pnpm update @getcirrus/pds --latest
```

## Test locally

```bash
pnpm dev
```

The Vite dev server starts the Worker locally on port 5173. Use `pds status --dev` and `pds passkey list --dev` to verify auth and the Durable Object still work as expected.

## Deploy

```bash
pnpm run deploy
```

This will build the worker and deploy it to Cloudflare. The Durable Object's storage is preserved. Existing sessions remain valid unless a release explicitly invalidates them (the changelog calls this out).

After deploy, run `pds status` against production to confirm the upgraded Worker is healthy.

## Roll back

If the new release is broken, roll back by pinning the previous version:

```bash
pnpm add @getcirrus/pds@<previous-version>
pnpm run deploy
```

The Durable Object's storage is forward-compatible within a major version. Rolling back across a major may not work if the release included storage migrations — the changelog flags this.

## Updating the scaffolder

The scaffolder (`create-pds`) is a separate package. It does not need to be updated to update an existing deployment; `create-pds` is only used to scaffold a new project.

To use a newer scaffolder for a new project:

```bash
npm create pds@latest
```
