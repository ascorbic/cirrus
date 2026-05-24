---
title: The AT Protocol in 5 minutes
description: The minimum understanding of handles, DIDs, repositories, records, and federation needed to run a PDS.
---

This page covers the parts of the AT Protocol that matter for running a PDS. For the full specification, see [atproto.com](https://atproto.com).

## Handles and DIDs

A **handle** is the human-readable name for an account: `alice.example.com`, `bsky.app`. Handles look like domain names because they are verified using DNS or HTTPS.

A **DID** (Decentralized Identifier) is the permanent, machine-readable identity for the account. A DID looks like `did:plc:abc123def456...` or `did:web:alice.example.com`. The handle can change over time; the DID does not.

Resolving a handle returns a DID. Resolving a DID returns a **DID document** that lists the account's signing key and the URL of its PDS.

Cirrus supports two DID methods:

- **`did:web`** — the DID document is served at `https://<domain>/.well-known/did.json`. The domain owner controls the DID. Losing the domain means losing the identity.
- **`did:plc`** — the DID document is stored in the PLC directory, a public log. Recovery keys can rotate the active signing key without losing the identity. This is the default for accounts on Bluesky.

See [Identity and your signing key](/concepts/identity/) for the trade-offs.

## Repositories and records

Every account has a **repository**: an append-only, cryptographically signed store of all the account's data. The repository is a Merkle search tree of **records**. Every commit signs the tree's root, which makes the entire history verifiable.

Records have:

- A **collection** (the schema, also called a **lexicon**): `app.bsky.feed.post`, `app.bsky.graph.follow`, `app.bsky.actor.profile`.
- A **record key** (rkey): usually a [TID](https://atproto.com/specs/tid), a sortable timestamp.
- A **value**: JSON conforming to the collection's lexicon.

A post in Bluesky is a record in `app.bsky.feed.post`. A follow is a record in `app.bsky.graph.follow`. Profile information is a record in `app.bsky.actor.profile`. Liking a post creates a record in `app.bsky.feed.like`. The PDS stores all of these in the repository.

Records are addressed by an **AT URI**: `at://did:plc:abc.../app.bsky.feed.post/3kxyz...`.

## Blobs

Records reference **blobs** by CID. A blob is binary content (image, video) that lives outside the repository. The repository contains a `blob` reference; the bytes live in object storage.

Cirrus stores blobs in a Cloudflare R2 bucket. The PDS serves them via `com.atproto.sync.getBlob`.

## The PDS, relays, and AppViews

The AT Protocol splits responsibilities across three roles:

- A **PDS** holds one or more accounts' repositories. It serves writes (create record, delete record, upload blob) and emits a stream of events when records change.
- A **relay** subscribes to the firehose of many PDSes and aggregates the events into a single stream. Anyone wanting "all the activity on the network" reads from a relay.
- An **AppView** consumes the relay stream, indexes everything, and serves application-level reads. The Bluesky app reads timelines, profiles, and notifications from `api.bsky.app`, which is an AppView.

Cirrus is the PDS. It does not host an AppView. Cirrus proxies unknown XRPC reads to the Bluesky AppView automatically, so the account appears in the Bluesky app exactly like an account hosted on `bsky.social`.

## The firehose

When a record changes, the PDS sequences a commit event and broadcasts it over `com.atproto.sync.subscribeRepos`. Relays subscribe to this WebSocket to mirror the repository state.

Cirrus implements the firehose. See [The firehose](/concepts/firehose/) for the event shape.

## Federation, in practice

For most users, federation means: the PDS publishes a DID document and emits a firehose. Once a relay subscribes (Bluesky's relay does this automatically when a new DID appears on the network), the rest of the network discovers the account through the AppView.

The PDS does not need to talk to other PDSes directly. The federation happens through relays and AppViews.
