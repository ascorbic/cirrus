---
title: pds CLI
description: Every subcommand the pds CLI exposes, with flags and behaviour.
---

The `pds` command is the operator interface for a Cirrus deployment. It is installed automatically into the scaffolded project — invoke it through the project's package manager:

```bash
pnpm pds <command>
```

Every command supports `--dev` to target a local dev server (`http://localhost:5173`) instead of production. Set the `PORT` env var to override the dev port.

## init

Run the interactive setup wizard.

```bash
pnpm pds init [--production]
```

**What it does:**

- Authenticates with Cloudflare if needed. If multiple accounts are linked, prompts to pick one and writes the `account_id` to `wrangler.jsonc`.
- Asks whether this is a migration or a fresh account.
- Prompts for the PDS hostname, account handle, DID (default `did:web:<hostname>` for new accounts; resolved from the source handle when migrating), Cloudflare Worker name (default derived from the handle), data placement, optional email address, and account password.
- Generates a signing key, JWT secret, and password hash.
- Writes public values to `wrangler.jsonc` (including the Worker name and the `pds.example.com` route as a `custom_domain`) and secrets to `.dev.vars`.
- On `--production`, uploads secrets to Cloudflare as Worker secrets. Otherwise, asks whether to push secrets after writing them locally and whether to deploy the Worker.

The wizard prints the signing key once during the run. **Back it up immediately.** See [Back up your signing key](/guides/back-up-signing-key/).

Re-running `init` against an existing deployment uses the existing key from `.dev.vars` and continues configuration. If no key is found, it exits with **Key Recovery Required**.

## migrate

Transfer an account from another PDS to the current Cirrus deployment.

```bash
pnpm pds migrate [--dev] [--clean]
```

**Prompts for:** source PDS hostname, current handle, current password.

**Behaviour:**

- Creates an inactive account on the target.
- Imports the repository.
- Imports all blobs.
- Resumes from a checkpoint if interrupted.

`--clean` discards the checkpoint and starts over. Without it, re-running picks up where the previous run stopped.

Full walkthrough: [Migrate from Bluesky](/guides/migrate-from-bluesky/).

## identity

Submit the PLC operation that rotates the DID to point at Cirrus.

```bash
pnpm pds identity [--dev] [--token <token>]
```

Applies only to `did:plc` accounts. `did:web` identities do not use PLC operations, so this command exits early on a `did:web` DID.

**Behaviour:**

- Requests an email confirmation token from the source PDS.
- Prompts for the token (skipped when `--token` is passed on the command line).
- Asks the source PDS to co-sign the PLC operation.
- Submits the signed operation to `plc.directory`.

Used during migration after the repository transfer completes.

## activate

Activate the account on the current PDS.

```bash
pnpm pds activate [--dev] [-y|--yes]
```

Sets the account status to active. The PDS accepts write operations and serves the firehose.

Runs pre-activation checks (handle resolution, DID document, repo completeness) and prompts before activating. `-y`/`--yes` skips the confirmation prompts.

Used after migration to mark the target PDS authoritative.

## deactivate

Deactivate the account on the current PDS.

```bash
pnpm pds deactivate [--dev] [-y|--yes]
```

Sets the account status to inactive. Write operations are rejected. The PDS still responds to identity probes and `describeServer`.

Prompts before deactivating. `-y`/`--yes` skips the confirmation.

Used after migrating away to mark the source as no longer authoritative.

## migrate-token

Generate a short-lived token authorising migration to another PDS.

```bash
pnpm pds migrate-token [--dev]
```

Prints a token valid for 15 minutes. The token is consumed by the target PDS's import flow.

Full walkthrough: [Migrate to another PDS](/guides/migrate-to-another-pds/).

## emit-identity

Emit an identity event to the firehose to prompt relays to refresh.

```bash
pnpm pds emit-identity [--dev]
```

Used after a handle change or PLC rotation to accelerate the network's view of the change.

## status

Health check.

```bash
pnpm pds status [--dev]
```

Reports:

- Connectivity to the PDS.
- Handle resolution.
- DID document contents.
- Repository revision and integrity.
- Blob count.
- AppView indexing state.

Each check prints a green ✓ or a red ✗. Failed checks include a hint.

## dashboard

Open a live terminal dashboard.

```bash
pnpm pds dashboard [--dev]
```

Shows:

- Account status (active/inactive), handle, DID, hostname, and Cirrus version.
- Per-collection record counts (posts, likes, follows, lists, and others) with friendly names.
- Network checks: handle resolution method (`dns`/`https`) and DID document fetch.
- Per-relay connection status (`active`/`idle`/`offline`/`throttled`/`banned`).
- Firehose subscriber count, latest sequence number, and recent subscriber connections (relative time, cursor, IP).
- Recent firehose events streamed over WebSocket (timestamp, sequence, action, path).
- Recent notifications (likes, reposts, follows, mentions, replies, quotes).

Footer keybindings depend on account state: `[a]` activate when inactive; `[r]` request crawl and `[e]` emit identity when active. `[q]` exits.

## passkey

Manage WebAuthn passkeys.

### passkey add

```bash
pnpm pds passkey add [--dev] [-n|--name <name>]
```

Starts a registration flow. Prints a one-time URL (and QR code) valid for ten minutes. Open the URL on a passkey-capable device and complete registration. `-n`/`--name` labels the passkey (for example `iPhone`, `MacBook`); without it, the command prompts for a name.

### passkey list

```bash
pnpm pds passkey list [--dev]
```

Lists all registered passkeys with their names and last-used timestamps.

### passkey remove

```bash
pnpm pds passkey remove [--dev] [--id <credentialId>] [-y|--yes]
```

Prompts to select a passkey from the list and removes it. `--id` skips the selection prompt and targets a specific credential. `-y`/`--yes` skips the confirmation prompt.

Full walkthrough: [Set up passkey login](/guides/passkey-login/).

## app-password

Manage app passwords for third-party clients.

### app-password create

```bash
pnpm pds app-password create [--dev] [-n|--name <name>]
```

Prompts for a name, then prints a freshly generated app password (format `xxxx-xxxx-xxxx-xxxx`). The password is shown once. `-n`/`--name` skips the name prompt.

### app-password list

```bash
pnpm pds app-password list [--dev]
```

Lists the names of all created app passwords. Does not show the passwords themselves.

### app-password revoke

```bash
pnpm pds app-password revoke [--dev] [-n|--name <name>] [-y|--yes]
```

Prompts to select an app password to revoke. `-n`/`--name` targets a specific app password by name. `-y`/`--yes` skips the confirmation prompt.

Full walkthrough: [Create an app password](/guides/app-password/).

## secret

Generate and store credentials. Each `secret` subcommand writes the value through `wrangler secret put` to Cloudflare by default — no prompt, no local copy. Pass `--local` to write to `.dev.vars` instead.

### secret key

```bash
pnpm pds secret key [--local]
```

Generates a fresh secp256k1 signing keypair. Writes `SIGNING_KEY` (private) and `SIGNING_KEY_PUBLIC` (public, multibase-encoded).

Rotating the signing key has follow-up steps. See [Manage secrets and rotate keys](/operate/secrets/).

### secret jwt

```bash
pnpm pds secret jwt [--local]
```

Generates a fresh random `JWT_SECRET`. Rotating invalidates all existing session JWTs.

### secret password

```bash
pnpm pds secret password [--local]
```

Prompts for a new account password, bcrypts it, and writes `PASSWORD_HASH`.

## Global flags

| Flag | Effect |
|---|---|
| `--dev` | Target `http://localhost:5173` instead of production. Set `PORT` to override the dev port. |
| `--local` | (secret only) Write to `.dev.vars` instead of pushing to Cloudflare. |
