---
title: The firehose
description: What Cirrus emits when records change, and how relays subscribe to it.
---

The **firehose** is the AT Protocol's real-time event stream. Every PDS emits one. Relays subscribe to PDS firehoses, deduplicate the streams, and serve a combined firehose to AppViews and other consumers.

Cirrus implements `com.atproto.sync.subscribeRepos` (the sync 1.1 firehose). This page describes what events Cirrus emits, how the wire format works, and how to subscribe.

## What triggers an event

Any change that produces a new repository commit sequences a firehose event. In practice, this means:

- `createRecord`
- `putRecord`
- `deleteRecord`
- `applyWrites` (one event per commit, batching multiple record operations)
- `importRepo` (during migration; events are emitted for the imported state)
- `uploadBlob` does **not** emit a firehose event on its own — only the record that references the blob does.

Identity changes (handle updates) and account status changes (activate, deactivate) emit dedicated event types. Operations that change repository state without producing a commit diff — repo import, key rotation, account activation — emit a `#sync` event carrying the current commit block.

## The wire format

The endpoint is a WebSocket upgrade:

```
GET /xrpc/com.atproto.sync.subscribeRepos
```

The server pushes binary frames. Each frame is a concatenation of two DAG-CBOR objects:

1. **Header.** Contains the event type (`#commit`, `#identity`, `#sync`, `#account`).
2. **Body.** Contains the event payload.

For a `#commit` event, the body includes:

- `seq` — monotonically increasing sequence number.
- `rebase` — always false (kept for compatibility).
- `tooBig` — true if the diff exceeded the carry limit.
- `repo` — the account DID.
- `commit` — the CID of the new commit.
- `rev` — the new repository revision.
- `since` — the previous revision.
- `blocks` — a CAR file containing the new blocks.
- `ops` — list of record operations: `{ action, path, cid }`.
- `prevData` — CID of the previous data root (sync 1.1).
- `blobs` — list of blob CIDs referenced by the commit. Always empty in Cirrus today.
- `time` — ISO timestamp.

The body matches the [sync 1.1 spec](https://atproto.com/specs/sync); Cirrus emits the same shape as the reference PDS.

## Cursor and replay

Subscribers pass a `cursor` query parameter to resume from a specific sequence number:

```
GET /xrpc/com.atproto.sync.subscribeRepos?cursor=12345
```

Cirrus replays every event from that cursor forward, then continues with live events. The `firehose_events` table in the Durable Object's SQLite stores past events; the replay window is bounded by an internal retention default of 10000 events. There is no CLI knob to tune this.

A cursor of `0` starts from the beginning.

## What relays do with it

Bluesky operates the main relay (`bsky.network`). When a new DID appears on the network (someone follows the account, or the account posts and the post is referenced), the relay discovers the DID, reads the DID document for the PDS endpoint, and subscribes to that PDS's firehose.

For Cirrus, the practical effect is: once an account is live and has any interaction with the wider network, the relay subscribes automatically. No registration step.

Other relays operate similarly. There is no allow-list to join — any relay can subscribe to any PDS's firehose, and PDSes are not expected to gate it.

## Verifying events

Every commit in the firehose is signed by the account's signing key. Subscribers verify signatures against the public key in the DID document. Signatures that do not verify are rejected by well-behaved relays.

Cirrus signs commits with the secp256k1 key in `SIGNING_KEY`. The corresponding public key is in the DID document (and in `SIGNING_KEY_PUBLIC` for serving `did:web` documents).

## Buffering and back-pressure

Cirrus broadcasts to all connected WebSocket clients on each event. Slow consumers do not back-pressure the writer; the firehose is fire-and-forget by design. A consumer that falls behind reconnects with a cursor to replay.

Cirrus uses Cloudflare's WebSocket Hibernation API. Idle WebSocket connections do not keep the Durable Object hot, which matters for cost on a single-user PDS.

## Testing the firehose

A quick way to confirm the firehose is working:

```bash
npx @atcute/cli sync subscribe-repos --pds https://pds.example.com
```

This connects, prints the cursor, and streams events as they arrive. Create a post in the Bluesky app and watch the event appear.
