---
title: Prerequisites
description: Accounts, services, and domain setup to complete before installing Cirrus.
---

Get the following in place before running the installer. Most steps take a few minutes; DNS propagation can take longer.

## A Cloudflare account

Cirrus runs on Cloudflare Workers and stores blobs in R2, so you need a Cloudflare account.

Sign up at [cloudflare.com](https://cloudflare.com) if needed. The free Workers plan is enough to start. R2 needs to be enabled separately from the R2 section of the dashboard, and requires a payment method on file. Usage should still be within the free tier for typical personal use.

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

## Bluesky account credentials, if migrating

Migrating an existing Bluesky account requires:

- The current handle and account password.
- Access to the email address registered with Bluesky (for the PLC operation token).

Cirrus also supports creating a new account from scratch. The wizard offers both paths.

Once the Cloudflare account is live and the domain shows as **Active**, continue to the [Quick start](/start/quick-start/).
