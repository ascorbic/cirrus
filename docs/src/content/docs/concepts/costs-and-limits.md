---
title: Costs and limits
description: What Cirrus costs to run on Cloudflare, and the hard limits to plan around.
---

Cirrus is built to be cheap to run for a single account. Most personal PDS deployments fit inside Cloudflare's free tier. This page covers the cost model and the limits that matter.

## What gets billed

Three Cloudflare products, each priced separately:

- **Workers** — request count, CPU time per request.
- **Durable Objects** — request count, wall-clock duration, storage (SQLite-backed).
- **R2** — storage (per GB-month), Class A operations (writes), Class B operations (reads), no egress fees.

Refer to [Cloudflare's current pricing](https://developers.cloudflare.com/workers/platform/pricing/) for exact numbers; this page does not quote prices that can change.

## What a personal PDS typically uses

For an active single-user account on the Bluesky network, expect:

- **Worker requests:** hundreds to low thousands per day, mostly firehose subscribers and the Bluesky app's reads when you are actively using Bluesky.
- **Durable Object requests:** every write, every firehose broadcast. Lower than the Worker count.
- **Durable Object SQLite queries:** these are billed by the row, so large repos with many records can have higher costs. The more expensive operations are cached aggressively to keep this low.
- **Durable Object storage:** under 100 MB for the repository in most cases.
- **R2 storage:** dominated by blobs. A few hundred MB for an account with many image posts.
- **R2 operations:** one Class A per blob upload, one Class B per blob fetch.

The free tier of Workers covers up to 100,000 requests per day, which is well above what a personal PDS uses for its own traffic. R2 has a generous free tier for storage and operations.

## What can push the bill up

In day-to-day use, most requests are not read directly from a PDS, but are served from caches or relays. However by its nature a PDS is a public source of truth, and any client can query it directly. This means that unusual traffic patterns can emerge from the network, and the PDS operator has no control over this.

- **Misbehaving firehose subscribers.** A poorly-configured relay can sometimes make a lot of requests. If a client reconnects often, each reconnect replays from a cursor and re-broadcasts events. Well-behaved relays do not do this.
- **Many large blobs.** Video, in particular, increases R2 storage. This is unlikely to be a problem for most personal accounts.

Cirrus does not implement any rate limiting beyond what Cloudflare provides. For unusual traffic, the Cloudflare dashboard's analytics show what is consuming requests.

## Hard limits

These are limits set by Cirrus or by the platform that cannot be raised without code changes:

| Limit                                   | Value                      | Source                     |
| --------------------------------------- | -------------------------- | -------------------------- |
| Blob upload size                        | 60 MB                      | Cirrus                     |
| Single Worker request CPU               | 30 s (paid) / 10 ms (free) | Cloudflare Workers         |
| Durable Object SQLite size              | 10 GB                      | Cloudflare Durable Objects |
| Single record size                      | ~1 MB practical            | AT Protocol + lexicon      |
| WebSocket message size                  | 1 MB                       | Cloudflare Workers         |
| Concurrent WebSocket connections per DO | thousands (no hard limit)  | Cloudflare Durable Objects |

The 60 MB blob limit is hardcoded in `uploadBlob`. That covers full-resolution photos and short videos. The Bluesky app will compress video before uploading the blob, and places its own limits on file sizes. However other apps might upload larger files. Anything larger has to be split, hosted externally, or compressed before upload.

The 10 GB SQLite limit is the ceiling for the repository size. The repository is the metadata — record values, MST nodes, commit log. Blobs are not counted. A heavily-used personal account is in the low hundreds of MB.

## Soft limits worth knowing

- **Single Durable Object means single region.** Latency from the other side of the world is real. The repository write path is fast but not edge-local.
- **Worker CPU time** for big operations like CAR exports of a large repository can approach the per-request budget. The `getRepo` endpoint streams to keep memory low, but a very large repository can still be slow to serve.
- **Firehose broadcast fan-out** is O(connected clients). For a personal PDS, this is in the low tens (one or two relays, maybe a personal subscriber). For a popular relay subscribing, it is one client receiving every event.

## Reading the bill

The Cloudflare dashboard breaks costs down by product. For a Cirrus deploy, look at:

- **Workers & Pages → Analytics & Logs** for request counts and CPU time.
- **Workers & Pages → Durable Objects → namespace** for DO request counts and storage.
- **R2 → bucket → Metrics** for storage and operation counts.

For most personal accounts, the bill is dominated by R2 storage once it exceeds the free tier, which only happens with a meaningful amount of media.
