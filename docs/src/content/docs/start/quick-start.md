---
title: Quick start
description: Scaffold a Cirrus project, run the setup wizard, and deploy a working PDS to Cloudflare.
---

This page takes a fresh machine to a deployed PDS in around fifteen minutes, assuming the [prerequisites](/start/prerequisites/) are in place.

:::tip[Prefer to watch]
The [Atmosphere Conference talk](/#watch-the-walkthrough) on the home page covers the same end-to-end setup as a video.
:::

## Scaffold and set up

Run the `create-pds` scaffolder:

```bash
npm create pds@latest
```

This single command does the whole setup end to end:

1. Prompts for a folder name, package manager, and whether to initialise a git repository.
2. Copies the project template into the folder.
3. Installs dependencies.
4. Runs the setup wizard (`pds init`) inside the new project.

The setup wizard then collects the information needed to deploy:

1. **Cloudflare login.** If `wrangler` is not authenticated, the wizard opens a browser to sign in.
2. **Account choice.** New account or migration from an existing PDS.
3. **Handle and DID.** The handle (for example `alice.example.com`) and the DID method. New accounts default to `did:plc`. Migrations carry the existing DID across.
4. **Hostname.** The domain that will serve the PDS (for example `pds.example.com`).
5. **Account password.** Used to sign in from the Bluesky app.
6. **Data placement.** A Cloudflare location hint. See [Data placement](/concepts/data-placement/) — this choice cannot be changed after the first deploy.

The wizard generates a signing key, a JWT secret, and a password hash. It writes the public values to `wrangler.jsonc` and the secrets to `.dev.vars`.

:::danger[Back up the signing key]
If you are creating a new `did:web` account, the wizard prints the signing key once. Save it to a password manager or an encrypted backup before continuing. Cloudflare secrets cannot be retrieved after they are set, and a lost key cannot be recovered for `did:web` accounts. See [Back up your signing key](/guides/back-up-signing-key/).
:::

For a non-interactive scaffold (defaults for everything), use the `--yes` flag:

```bash
npm create pds@latest -- --yes --pm pnpm
```

See the [create-pds CLI reference](/reference/create-pds-cli/) for every flag.

:::note[Already scaffolded without running the wizard?]
If the scaffolder was run with `--skip-init` (or the wizard was skipped for any other reason), run the wizard manually from inside the project directory:

```bash
pnpm pds init
```

A fresh `npm create pds` run does this automatically — `pds init` does not need to be run again.
:::

## Deploy

From the project directory:

```bash
pnpm run deploy
```

This runs `wrangler deploy`, which uploads the Worker, creates the Durable Object namespace, and provisions the R2 bucket. The first deploy takes a minute or two.

For a production deploy, push the secrets to Cloudflare:

```bash
pnpm pds init --production
```

The `--production` flag writes the secrets stored in `.dev.vars` to Cloudflare as Worker secrets instead of keeping them local.

## Verify the deploy

Open `https://pds.example.com/.well-known/atproto-did` (replacing the hostname). The response is the account DID.

Open `https://pds.example.com/xrpc/com.atproto.server.describeServer`. The response is a JSON object describing the PDS's capabilities.

For an interactive health check, run:

```bash
pnpm pds status
```

This checks connectivity, resolves the handle, verifies the repository is initialised, and reports the blob count.

## Next

- New account: continue to [First login](/start/first-login/) to sign in from the Bluesky app.
- Migrating an existing account: follow [Migrate from Bluesky](/guides/migrate-from-bluesky/).
