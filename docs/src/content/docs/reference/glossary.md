---
title: Glossary
description: The AT Protocol and Cloudflare terms most relevant to running Cirrus.
---

## AppView

A service that consumes the firehose, indexes records, and serves application-level reads. The Bluesky AppView (`api.bsky.app`) is the one most Cirrus deployments rely on for timeline, profile, and notification queries. Cirrus proxies to the AppView automatically.

## AT URI

The identifier for a record. Format: `at://<did>/<collection>/<rkey>`. Example: `at://did:plc:abc.../app.bsky.feed.post/3kxyz...`.

## Blob

Binary content (image, video) referenced from a record but stored separately. Cirrus stores blobs in R2. Identified by CID.

## CAR file

Content-Addressable aRchive. A binary format for sharing a set of IPLD blocks with a known root. Used by `getRepo` (export) and `importRepo` (migration import).

## CID

Content Identifier. A self-describing hash that uniquely identifies a block of data. Records, commits, MST nodes, and blobs are all addressed by CID.

## Commit

A signed entry in the repository that records a new root of the Merkle search tree. Every write produces a new commit, signed with the account's signing key.

## DAG-CBOR

Deterministic CBOR encoding used by the AT Protocol for all binary-encoded data: blocks, firehose frames, signed payloads.

## DID

Decentralized Identifier. A permanent identifier for an account. Cirrus supports `did:plc` (logged in the PLC directory) and `did:web` (served from a domain). See [Identity and your signing key](/concepts/identity/).

## DID document

A JSON document describing a DID: the account's signing key, its PDS endpoint, and any handle aliases. Served from `plc.directory` for `did:plc` or from the domain for `did:web`.

## DPoP

Demonstrating Proof of Possession. A scheme for binding OAuth tokens to a client-held key pair so that a stolen token is not usable on its own. Cirrus requires DPoP for all OAuth-authenticated requests.

## Durable Object

A Cloudflare Workers primitive: a single-instance addressable object with strong consistency. Cirrus uses one Durable Object per account to hold the repository SQLite database.

## Firehose

The real-time stream of repository events from a PDS. Exposed at `com.atproto.sync.subscribeRepos`. Subscribers (relays) get every commit as soon as it is sequenced.

## Handle

The human-readable name for an account, in DNS-style syntax (`alice.example.com`). Verified through DNS TXT records or HTTPS files. Distinct from the DID — handles can change, DIDs cannot.

## Lexicon

A schema definition for a record collection. Defines the shape of records in `app.bsky.feed.post`, `app.bsky.graph.follow`, etc. Cirrus validates records against the loaded lexicons.

## Merkle search tree (MST)

The data structure underlying the repository. A signed tree of records that allows efficient diffs and proofs. Each commit signs the tree's root CID.

## PDS

Personal Data Server. The server that holds an account's repository and emits its firehose. Cirrus is one implementation; `bsky.social` is another.

## PLC

The directory that stores `did:plc` documents. A public, append-only log operated by Bluesky. Allows key rotation through a separate recovery key.

## R2

Cloudflare's object storage. Cirrus uses an R2 bucket for blob storage.

## Record

A piece of data in the repository. Has a collection (the schema, e.g. `app.bsky.feed.post`), a record key (rkey, usually a TID), and a value (the JSON payload).

## Relay

A service that subscribes to the firehose of many PDSes and aggregates the events into a single stream. AppViews and other consumers read from a relay rather than from each PDS individually.

## Repository

The append-only, cryptographically signed store of an account's data. Holds records, MST nodes, and commits.

## RPC (Durable Object RPC)

The mechanism by which the Worker calls methods on the Durable Object. Available since compatibility date `2024-04-03`. Cirrus uses RPC instead of fetch handlers for cleaner type-safe interfaces.

## Service JWT

A short-lived JWT (5 minutes) signed by the account's signing key, used to assert the account's identity to other AT Protocol services. Cirrus uses service JWTs to authenticate proxy calls to the AppView.

## Signing key

The secp256k1 private key that signs every repository commit. The most important piece of state. See [Identity and your signing key](/concepts/identity/) and [Back up your signing key](/guides/back-up-signing-key/).

## TID

Time-sorted Identifier. The default rkey format: a base32-encoded timestamp with random bits, sortable in chronological order.

## Worker

A Cloudflare Workers script. Stateless, runs at the edge. The Cirrus Worker handles routing, auth, and proxying; it delegates stateful work to the Durable Object.

## XRPC

The HTTP-based RPC protocol used by the AT Protocol. Methods are identified by NSID (`com.atproto.repo.createRecord`). Cirrus implements a subset directly and proxies the rest.
