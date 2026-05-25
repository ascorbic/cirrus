---
title: Status and roadmap
description: What works today, what is in progress, and what is deliberately out of scope.
---

Cirrus is experimental beta software under active development. The core is functional and migration has been tested. This page is the honest current state.

For the up-to-date detail, the [plan documents](https://github.com/ascorbic/cirrus/tree/main/plans) in the repository are the source of truth.

## What works

- **Repository operations.** Create, put, delete, list records. Batch writes. Validation against loaded lexicons.
- **Blob storage.** Upload and serve via R2. 60 MB limit per blob.
- **Federation.** CAR export, block fetch, blob listing, identity resolution.
- **Firehose.** Real-time `subscribeRepos` over WebSocket. Sync 1.1 event format.
- **Account migration (in).** Import an existing account from another PDS, including blobs and the PLC rotation. Verified end-to-end.
- **Account migration (out).** Generate migration tokens for a target PDS to import.
- **OAuth 2.1.** Full provider with PAR, PKCE, DPoP, granular scopes, client metadata discovery.
- **Passkeys.** WebAuthn registration and OAuth sign-in.
- **Session auth.** Bluesky app sign-in via `createSession` with password or app password.
- **App passwords.** Per-client revocable credentials.
- **CLI.** Setup wizard, migration, identity rotation, status, dashboard, secret management.
- **Granular scope coverage.** Most endpoints enforce scope; a few admin-style endpoints still need fine-grained checks.

## What is deliberately out of scope

The following are not on the roadmap. A multi-user PDS or a different platform would be a better fit:

- **Multi-tenant accounts.** One Cirrus deploy serves one DID. Many accounts means many deploys.
- **Email-based password reset.** No email infrastructure. Local password rotation via `pds secret password` is the alternative.
- **Moderation tooling.** Cirrus is a PDS, not an AppView or a moderation service. Labels and reports flow through the network's existing services.
- **Admin operations for other users.** Single-user means single-owner. There are no admin endpoints to manage other accounts.

## What might come

Plans in the queue but not committed:

- Deeper observability hooks (custom log destinations, structured event emission).
- A web UI for operator tasks that the CLI handles today.

## Beta caveats

The breaking-changes risk is concentrated in:

- **Storage schema.** The Durable Object's SQLite schema can change between minor versions. The release notes call out migrations.
- **Wire-level details of the firehose.** Sync 1.1 is the current target; further protocol changes are possible.

The `@getcirrus/pds` changelog is the canonical place to read about breaking changes before updating. See [Update a deployed PDS](/guides/update/).

## Reporting issues

[GitHub issues](https://github.com/ascorbic/cirrus/issues) is the place. Include:

- The version of `@getcirrus/pds` in use.
- The `pds status` output.
- Worker logs from the Cloudflare dashboard.
- A clear repro if possible.
