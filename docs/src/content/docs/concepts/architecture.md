---
title: How Cirrus is built
description: The Worker, the Durable Object, and R2 — what each component does and why the stack looks this way.
---

Cirrus runs as a single Cloudflare Worker backed by a Durable Object and an R2 bucket. There are no other moving parts.

## The components

**Worker (stateless).** The Worker handles every incoming request. It routes XRPC calls, validates authentication, serves the DID document at `/.well-known/did.json`, serves OAuth endpoints, and forwards repository operations to the Durable Object. It runs at the Cloudflare edge.

**Account Durable Object (stateful).** The Durable Object holds the account's repository. It owns an embedded SQLite database that stores records, commits, the firehose event log, OAuth tokens, app passwords, passkeys, and account preferences. The Durable Object is single-instance: there is exactly one running at a time, in one region.

**R2 bucket (blob storage).** The bucket holds blob bytes (images, video). The Worker streams blobs directly from R2 on read and writes them on `uploadBlob`. Blobs are content-addressed by CID.

The dataflow for a write looks like this:

1. The client sends an authenticated XRPC request to the Worker.
2. The Worker validates auth, then forwards the request to the Durable Object via RPC.
3. The Durable Object updates the repository in SQLite, signs the new commit with the signing key, sequences a firehose event, and broadcasts the event to subscribed WebSocket clients.
4. The Worker returns the response.

The dataflow for a blob upload is similar, except the bytes are streamed to R2 by the Worker and the Durable Object only records the blob reference.

## Why a single Durable Object

The repository is a serial data structure: every commit signs a new tree root, and commits must be ordered. A single Durable Object guarantees serial access without any locking machinery. SQLite inside the Durable Object provides transactions and durability for free.

This is also the reason Cirrus is single-user. A multi-tenant PDS would need either a Durable Object per account (workable, but with a fan-out cost on cross-account operations) or a different storage model entirely.

## Why no separate database

The Durable Object's storage *is* the database. SQLite, embedded, with strong consistency. The repository, the firehose log, and the auth tables all live in the same file. Backing up the PDS means exporting the repository as a CAR file (`com.atproto.sync.getRepo`) — the rest is derivable.

## Why R2

Blobs need cheap, large, content-addressed storage. R2 is built for exactly that, and it shares billing and access control with the Worker. The Worker streams blobs to and from R2 without proxying through the Durable Object.

## What the Worker does not do

- **It does not index records.** The Durable Object's SQLite is for repository operations, not for full-text search or social-graph queries. The Bluesky AppView indexes records; the Worker proxies queries it does not implement directly.
- **It does not store sessions.** Session JWTs are signed and verified statelessly. No server-side session table.
- **It does not run cron jobs.** All state changes are triggered by incoming requests.

## What sits outside Cirrus

- **The Bluesky AppView (`api.bsky.app`)** serves social reads. Cirrus proxies any unknown XRPC method to it using a service JWT signed by the account.
- **A relay** (Bluesky operates one) subscribes to the firehose and aggregates it with other PDSes. Cirrus does not need to know about specific relays — any relay can subscribe to `com.atproto.sync.subscribeRepos`.
- **The PLC directory (`plc.directory`)** stores `did:plc` documents. Identity operations on a `did:plc` account write to PLC, not to the PDS.

## The repository on disk

The Durable Object's SQLite holds, at minimum:

- A block store keyed by CID for all repository blocks (commits, MST nodes, record values).
- A record index mapping `collection/rkey` to the current block CID.
- A blob reference table.
- A `firehose_events` table for the commit sequence.
- Tables for OAuth tokens, app passwords, passkeys, and `app.bsky.actor` preferences.

The repository is recovered from the block store on every cold start. The Durable Object lazy-initialises this on first use after a deploy.

## What about cold starts

Cloudflare Workers and Durable Objects both cold-start. For Cirrus the practical effect is a single-digit-millisecond delay on the first request after idle. This is invisible to the Bluesky app and to the firehose subscriber, which both reconnect transparently.

## What this stack does not handle

- **Disaster recovery between Cloudflare regions.** Durable Objects are single-region. If Cloudflare loses the region, the account is unavailable until the region recovers. The signing key (held by the account owner, not by Cloudflare) and the latest CAR export are the recovery floor.
- **Multi-tenant accounts.** One Cirrus deploy serves one DID.
- **Long-running background tasks.** Workers and Durable Objects are request-driven. There are no nightly jobs.
