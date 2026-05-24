---
title: Why run a PDS
description: The reasons to host an AT Protocol Personal Data Server, and the trade-offs to weigh before doing so.
---

A Personal Data Server (PDS) is where an AT Protocol account lives. The PDS holds the repository of records that make up the account: posts, follows, profile, likes, and the signed commits that bind them together. It also stores blobs (images, video) and emits the firehose events that let the rest of the network discover new activity.

Most people on Bluesky use the PDS that Bluesky operates. Running a personal PDS is an alternative.

## Reasons to run one

**Independence from platform changes.** A self-hosted PDS continues to serve the account even if the operator of a hosted PDS changes policy, pricing, or ownership. The cryptographic identity belongs to the holder of the signing key, not to any provider.

**Network resilience.** The AT Protocol works best with a diverse population of independent servers. Every self-hosted PDS makes the network harder to fail and harder to capture.

**Data sovereignty.** The repository sits on infrastructure under direct control. The choice of jurisdiction is explicit (see [Data placement](/concepts/data-placement/)).

**Portability.** A PDS exposes standard endpoints for export and migration. Moving between providers is a defined operation, not a favour to ask the current host.

## What running a PDS is not

A PDS is not a Bluesky competitor. The account, the handle, and the posts remain part of the Bluesky network. The PDS is just the server that holds them.

A PDS is not a way to opt out of moderation. Other services in the network (relays, AppViews, labelers) still see the records the PDS emits. Self-hosting changes where the data lives, not what it is.

A PDS is not a replacement for backups. The signing key is the only piece of the system that cannot be recovered by re-deriving from other state. Back it up. See [Back up your signing key](/guides/back-up-signing-key/).

## Reasons not to run one

**Cloudflare is the dependency.** Cirrus is designed for the Cloudflare Workers platform and uses Durable Objects and R2 directly. Running on a different provider would require a different PDS implementation.

**Operational responsibility shifts.** A self-hosted PDS means the operator handles secrets, key rotation, version upgrades, and DNS. The amount of work is small, but it is not zero.

**Cirrus is beta software.** Account migration has been tested and verified, but unexpected behaviour is still possible. See [Status and roadmap](/project/status/) for the current state.

## When Cirrus is a good fit

Cirrus is built for one person hosting one account. It is appropriate for individuals who want to control their own identity on the AT Protocol network, are comfortable running `npx`, and are willing to use Cloudflare as the underlying platform.

Multi-tenant hosting, organisations running many accounts, or anyone who needs admin/moderation features for users other than themselves should use a different PDS implementation. The reference implementation from Bluesky is the right starting point.
