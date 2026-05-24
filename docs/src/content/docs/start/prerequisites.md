---
title: Prerequisites
description: Accounts, services, and domain setup to complete before installing Cirrus.
---

Get the following in place before running the installer. Most steps take a few minutes; DNS propagation can take longer.

## A Cloudflare account

Cirrus runs on Cloudflare Workers and stores blobs in R2. Both require a Cloudflare account.

Sign up at [cloudflare.com](https://cloudflare.com) if needed. The free Workers plan is enough to start. R2 has its own pricing — see [Costs and limits](/concepts/costs-and-limits/).

R2 must be enabled on the account before deploying. Enable it from the R2 section of the Cloudflare dashboard. The first activation walks through accepting the R2 terms.

## A domain on Cloudflare

The PDS needs a hostname. Cirrus serves the account from a domain that is active in Cloudflare DNS.

The domain controls two things at once:

- The PDS hostname (for example `pds.example.com`).
- The account handle (for example `alice.example.com`) if `did:web` is used, or any compatible handle if `did:plc` is used.

Add the domain to Cloudflare:

1. Log into the Cloudflare dashboard.
2. Choose **Add a site** and enter the domain.
3. Follow the prompts to update the domain's nameservers at the registrar.
4. Wait for DNS to propagate. This usually takes a few minutes and can take up to 24 hours.

The domain must show as **Active** in the Cloudflare dashboard before the deploy step.

## Node.js and a package manager

Cirrus is distributed as npm packages. The scaffolder runs under Node 20 or later. Any of `pnpm`, `npm`, `yarn`, or `bun` work; the scaffolder asks which to use.

## A Bluesky account, if migrating

Migrating an existing Bluesky account requires:

- The current handle and password.
- Access to the email address registered with Bluesky (for the PLC operation token).

Cirrus also supports creating a new account from scratch. The wizard offers both paths.

## What is not required

- A separate database. The repository lives in the Durable Object's SQLite storage.
- A server, VM, or container runtime.
- Cloudflare Pages, KV, or D1.
- A pre-generated signing key. The wizard generates one. The wizard also prints it once for backup.

Once the Cloudflare account is live and the domain shows as **Active**, continue to the [Quick start](/start/quick-start/).
