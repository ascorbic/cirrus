---
title: Monitor your PDS
description: Tools for checking the deployment's health, watching live metrics, and reading logs.
---

Cirrus provides three monitoring surfaces: the `pds status` health check, the `pds dashboard` live metrics view, and Cloudflare's built-in observability for the Worker and R2.

## pds status

The fastest health check. Run from the project directory:

```bash
pnpm pds status
```

The output covers:

- **Connectivity** — the PDS responds to `describeServer`.
- **Handle resolution** — the handle resolves to the configured DID.
- **DID document** — the DID document points at the Cirrus hostname and the correct public key.
- **Repository** — the Durable Object's SQLite is initialised and the latest commit is verified.
- **Blob count** — number of blobs in R2.
- **AppView indexing** — the Bluesky AppView has indexed the account.

A failing check prints the cause and a hint. Use `pds status --dev` against a local dev server.

## pds dashboard

For continuous monitoring during a deploy, migration, or debugging session:

```bash
pnpm pds dashboard
```

This opens a terminal UI with two columns and two panels below them:

- **Repository** — record counts per collection (posts, likes, follows, reposts, lists, profile, and so on), sorted by activity.
- **Network** — handle and DID document resolution checks, status of each relay host the PDS is registered with, the count of currently connected firehose subscribers, the latest sequence number, and per-subscriber cursor and IP for up to three connections.
- **Events** — a live stream of commit and identity events from the firehose, with WebSocket connection status.
- **Notifications** — recent AppView notifications for the account (likes, reposts, follows, mentions, replies, quotes).

The header shows the configured hostname, handle, DID, and account active/inactive status. Contextual keybindings appear in the footer: `[a]` activate when the account is inactive, `[r]` request a relay crawl, `[e]` emit an identity event, `[q]` quit.

## Cloudflare observability

The Cloudflare dashboard provides per-Worker and per-Durable-Object metrics.

**Worker analytics** (Workers & Pages → the Cirrus worker → Analytics & Logs):

- Request count over time.
- CPU time distribution.
- Error rate.
- Request duration.

**Worker logs** (same section → Logs):

Realtime log streaming. Useful for catching errors as they happen. Set up persistent log storage with [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) if longer retention is needed.

**Durable Object analytics** (Workers & Pages → Durable Objects → the `ACCOUNT` namespace):

- Request count.
- Wall-clock time.
- Storage usage.

**R2 metrics** (R2 → the bucket → Metrics):

- Storage size.
- Class A operations (writes).
- Class B operations (reads).

## What to watch for

The metrics that matter for a personal PDS:

- **Worker error rate.** Should be near zero in steady state. A spike usually means a code bug or a misconfigured binding.
- **Durable Object storage growth.** The repository grows with every post. A sudden jump can mean an import or an unusually large record.
- **R2 storage growth.** Dominated by blob uploads. A sudden jump means new media.
- **Firehose lag.** If the AppView is slow to index, it shows up as posts taking time to appear in feeds.

## Alerts

Cloudflare supports notifications on Worker errors and quotas. Configure them in **Workers & Pages → Notifications**.

For more sophisticated monitoring (uptime checks, external probes), point a service like UptimeRobot or Better Stack at `https://pds.example.com/xrpc/com.atproto.server.describeServer`. A non-200 response is a clear signal the PDS is down.

## Reading logs

Cirrus does not emit a stable, documented catalogue of log lines. Request information visible in the Cloudflare dashboard's **Logs** view is the canonical source for inspecting what the Worker is doing in real time. Errors are written with `console.error`; routine requests are visible via Cloudflare's request tracing.

Enable [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) for searchable persistent retention if log inspection beyond the live tail is needed.
