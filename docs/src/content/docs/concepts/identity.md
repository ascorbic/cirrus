---
title: Identity and your signing key
description: How DIDs, signing keys, and handles fit together — and why the signing key is the one piece worth being paranoid about.
---

The signing key is the root of the account's identity on the AT Protocol. Every commit to the repository is signed with it. Every record's chain of provenance ends at it. The PDS is software; the signing key is the identity.

This page covers what the key does, how it relates to DIDs and handles, and what is at stake if it leaks or is lost.

## What the signing key signs

Every commit to the repository signs the new Merkle root. A relay (or any subscriber) verifies the signature against the public key in the DID document. A signature that does not verify is rejected by the network.

The signing key is also used to mint **service JWTs** for outbound calls to other AT Protocol services (such as the Bluesky AppView). These short-lived tokens assert "this request is from the account whose DID I sign for".

## Where the key lives

Cirrus stores the signing key as a Cloudflare Worker secret: `SIGNING_KEY` (for local dev, in `.dev.vars`). The Worker reads it on startup and passes it to the Durable Object for signing operations.

Cloudflare secrets are write-only: once set, they cannot be retrieved through the dashboard or the API. This is good for security and bad for recovery. **The wizard prints the key exactly once during `pds init`.** Save it then.

## DID methods supported

Cirrus supports two DID methods. The choice is made once and is hard to change later.

### did:web

A `did:web` DID is derived from a domain: `did:web:alice.example.com`. The DID document lives at `https://alice.example.com/.well-known/did.json`. The Cirrus Worker generates and serves that document itself from the configured `DID`, `HANDLE`, and `SIGNING_KEY_PUBLIC` — no separate hosting step. `pds init` provisions everything when did:web is selected.

**Properties:**
- The domain owner controls the DID.
- Losing the domain means losing the identity. There is no recovery.
- Rotating the signing key means publishing a new DID document. Old signatures become unverifiable to anyone who does not trust the new document.
- No third party is involved.

**Use `did:web` when:** the account is new, the domain is long-term, and external recovery isn't a goal.

### did:plc

A `did:plc` DID is a random identifier (`did:plc:abc123...`) whose DID document is stored in the [PLC directory](https://plc.directory), a public log operated by Bluesky. PLC supports key rotation through a separate **recovery key**.

**Properties:**
- The DID is not tied to a domain. The handle can change without changing the DID.
- Key rotation is possible if the recovery key was registered.
- PLC is a centralised log run by Bluesky. The log is publicly auditable but the operator is a single party.
- Migrated accounts almost always have `did:plc` because that is what Bluesky issued.

**Use `did:plc` when:** the account already exists on Bluesky, or recovery and handle portability matter more than independence from PLC.

The `pds init` wizard offers both. The default for a new account is `did:plc`.

## How handles relate to DIDs

A handle is a separate concept from a DID. The handle is verified by either:

- **DNS TXT record.** `_atproto.alice.example.com` returns `did=did:plc:...`.
- **Same-host HTTPS.** `https://alice.example.com/.well-known/atproto-did` returns the DID as plain text.

Cirrus serves the same-host file automatically when the handle and the PDS hostname share a domain. For handles on other domains, see [Choose a handle](/guides/choose-a-handle/).

Handles can change. DIDs cannot. A handle change is recorded in the DID document (for `did:plc`) or in the served `did.json` (for `did:web`); existing references to the DID continue to work.

## What happens if the key leaks

Anyone holding the signing key can sign commits on behalf of the account. They can post, follow, delete records, and effectively impersonate the account from the perspective of the network.

If the key leaks:

- For `did:plc` with a recovery key: rotate the signing key in PLC immediately. The old key is no longer trusted.
- For `did:web`: update the DID document at `/.well-known/did.json` to a new key. Old signatures stop verifying. There is no recovery key — the domain itself is the recovery mechanism.
- For `did:plc` without a recovery key: rotation is not possible without the original key. The identity is compromised.

## What happens if the key is lost

A lost key is different from a leaked key. Nobody else has it; the holder just cannot use it.

- **For `did:web`:** generate a new key, publish a new DID document. The identity continues with a fresh signing key but cryptographic continuity is broken: old signed commits cannot be verified against the new key. Existing followers and content survive; relays and AppViews accept the new commits because the DID document advertises the new key.
- **For `did:plc` with a recovery key:** rotate to a new signing key using the recovery key. The DID is preserved and cryptographic continuity holds.
- **For `did:plc` without a recovery key:** the account cannot publish new commits. Starting a new identity is the only option.

This is why backup matters more than any other operational concern. See [Back up your signing key](/guides/back-up-signing-key/).

## Rotating the key as a routine operation

Rotation is a defined operation, not an emergency. Periodic key rotation is reasonable hygiene.

For `did:plc` with a recovery key, the migration CLI flow can rotate the signing key as part of a re-init. For `did:web`, replace the public key in the DID document, replace the secret in Cloudflare, and redeploy. See [Manage secrets and rotate keys](/operate/secrets/).
