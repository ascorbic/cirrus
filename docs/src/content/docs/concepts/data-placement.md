---
title: Data placement
description: Where the Durable Object and R2 bucket live, the available location hints, and why the choice is permanent.
---

Cloudflare Workers and R2 are globally distributed, but certain resources have a specific region of residence. There are a number of reasons to choose a specific region, and the choice is permanent after the first deploy. The Durable Object lives in one region; the R2 bucket also has a region affinity. The choice is set at the first deploy and is hard to change afterwards.

This page describes the available options, what each implies, and why the decision matters.

## Why data placement matters:

- **Latency.** When you are using the Bluesky app, all of your requests go to your PDS. While the Worker is globally distributed, the Durable Object is not. The round-trip time to the Durable Object is the dominant factor in request latency. For a good experience, choose a region close to where you are.
- **Data sovereignty.** The Durable Object's region determines which jurisdiction's data-protection laws apply to the repository data. For compliance or personal reasons, some accounts must choose a specific region.

## What the placement controls

The Durable Object's region determines:

- Where the repository SQLite file is physically stored.
- Where every write request is processed.

The R2 bucket's region determines:

- Where blob bytes are stored at rest.

Read requests from the Bluesky app mostly come from the account holder, but requests from other clients can come from anywhere; Cloudflare routes them to the Durable Object's region. The latency is real but typically modest.

None of these affect Cloudflare cache locations or where a Worker runs, nor the Bluesky or other AppView cache.

## Options

The `DATA_LOCATION` setting in `wrangler.jsonc` accepts:

| Value  | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| `auto` | Cloudflare picks. Usually places near the first request after deploy. |
| `eu`   | Strict EU placement. Data stays in the EU jurisdiction.               |
| `wnam` | Western North America.                                                |
| `enam` | Eastern North America.                                                |
| `sam`  | South America.                                                        |
| `weur` | Western Europe (best effort: less strict than `eu`).                  |
| `eeur` | Eastern Europe (best effort: less strict than `eu`).                  |
| `apac` | Asia-Pacific.                                                         |
| `oc`   | Oceania.                                                              |
| `afr`  | Africa.                                                               |
| `me`   | Middle East.                                                          |

`eu` is the only **jurisdiction** mode — Cloudflare guarantees data residency. The other values are location _hints_ — Cloudflare tries to honour them but may place the Durable Object in a nearby region if the requested one is unavailable.

The `pds init` wizard asks for this value.

## Why it is hard to change

The Durable Object's storage is tied to the region. Moving a Durable Object to a new region means exporting its state, recreating the Durable Object in the new region, and importing. Cirrus does not automate this. Manual migration is possible but is functionally the same as setting up a new PDS and migrating the account to it.

The R2 bucket's region is similarly sticky. Cloudflare does not offer a one-click region change.

**Pick deliberately at first deploy.** If the answer changes later, plan a full account migration (see [Migrate to another PDS](/guides/migrate-to-another-pds/)).

## How to choose

For most personal accounts, the right answer is **the region closest to the account holder**.

For compliance-driven cases (an account that must legally remain in the EU), use **`eu`**.

For accounts that move geographically (someone who travels for half the year), **`auto`** lets Cloudflare pick at first deploy. The placement does not follow the account afterward.

:::note[FedRamp support]
If you are a government user and need to deploy deploy your PDS to a FedRamp region, contact [Matt Kane](https://bsky.app/profile/mk.gg) for custom support.
:::

## Reading the current placement

Check the current location in the Cloudflare dashboard:

- **Workers & Pages → Durable Objects → `ACCOUNT` namespace → instance → Location.**
- **R2 → bucket → Settings → Location.**
