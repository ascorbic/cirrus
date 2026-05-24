---
title: Data placement
description: Where the Durable Object and R2 bucket live, the available location hints, and why the choice is permanent.
---

Cirrus runs in a single Cloudflare region per deploy. The Durable Object lives in one region; the R2 bucket also has a region affinity. The choice is set at the first deploy and is hard to change afterwards.

This page describes the available options, what each implies, and why the decision matters.

## What the placement controls

The Durable Object's region determines:

- Where the repository SQLite file is physically stored.
- Where every write request is processed.
- Which jurisdiction's data-protection laws apply.

The R2 bucket's region determines:

- Where blob bytes are stored at rest.

Read requests from the Bluesky app or other clients can come from anywhere; Cloudflare routes them to the Durable Object's region. The latency is real but typically modest.

## Options

The `DATA_LOCATION` setting in `wrangler.jsonc` accepts:

| Value | Meaning |
|---|---|
| `auto` | Cloudflare picks. Usually places near the first request after deploy. |
| `eu` | Strict EU placement. Data stays in the EU jurisdiction. |
| `wnam` | Western North America. |
| `enam` | Eastern North America. |
| `sam` | South America. |
| `weur` | Western Europe (less strict than `eu`). |
| `eeur` | Eastern Europe. |
| `apac` | Asia-Pacific. |
| `oc` | Oceania. |
| `afr` | Africa. |
| `me` | Middle East. |

`eu` is the only **jurisdiction** mode — Cloudflare guarantees data residency. The other values are location *hints* — Cloudflare tries to honour them but may place the Durable Object in a nearby region if the requested one is unavailable.

The `pds init` wizard asks for this value.

## Why it is hard to change

The Durable Object's storage is tied to the region. Moving a Durable Object to a new region means exporting its state, recreating the Durable Object in the new region, and importing. Cirrus does not automate this. Manual migration is possible but is functionally the same as setting up a new PDS and migrating the account to it.

The R2 bucket's region is similarly sticky. Cloudflare does not offer a one-click region change.

**Pick deliberately at first deploy.** If the answer changes later, plan a full account migration (see [Migrate to another PDS](/guides/migrate-to-another-pds/)).

## How to choose

For most personal accounts, the right answer is **the region closest to the account holder**.

For compliance-driven cases (an account that must legally remain in the EU), use **`eu`**.

For accounts that move geographically (someone who travels for half the year), **`auto`** lets Cloudflare pick at first deploy. The placement does not follow the account afterward.

## Reading the current placement

Check the current location in the Cloudflare dashboard:

- **Workers & Pages → Durable Objects → `ACCOUNT` namespace → instance → Location.**
- **R2 → bucket → Settings → Location.**
