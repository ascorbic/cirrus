---
title: Atproto spaces (alpha)
description: How Cirrus implements permissioned data — private and shared spaces — and how space data is kept isolated from your public repository.
---

**Spaces** are the AT Protocol's proposal for permissioned data ([proposal 0016](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)): records that live on your PDS like public records do, but are only readable by people the space's owner has authorized. A private bookmarks collection, a members-only forum, a shared group — each is a space.

Cirrus implements the spaces alpha behind the `SPACES_ENABLED` flag. Everything about it — the protocol, the lexicons, the dependencies — is **alpha** and can break between builds. See [Enable spaces](/guides/enable-spaces/) for setup, and read the caveats below before turning it on.

## What a space is

A space is identified by a URI like:

```
at://did:web:alice.example.com/space/app.bsky.group/3kbcq3p7ad400
```

That's an **authority** (the DID that owns the space and decides who may read it), a **type** (an NSID describing what kind of space it is), and a **key** distinguishing multiple spaces of the same type.

Every participant stores *their own* records for a space in their own PDS — their **permissioned repo** for that space. Reading a space means collecting the repos of its writers from wherever each is hosted.

## The three roles Cirrus plays

Because Cirrus is single-user, one account wears three hats:

- **Repo host** — serving your own permissioned repos, one per space you have written into, whether you own the space or not.
- **Space host** — for spaces you own: issuing credentials to readers, tracking who has written, notifying syncers after writes, and managing membership.
- **Your PDS** — minting short-lived delegation tokens so apps you've signed into can read spaces hosted elsewhere.

## How access control works

Reading a space requires a **space credential** from its authority. The flow:

1. Your app asks your PDS for a **delegation token**: a 60-second, single-use JWT proving the app acts for you.
2. The app generates a P-256 key and asks the space's authority for a **credential** bound to it: a ten-minute JWT. A space that is publicly readable issues one without a delegation token.
3. Every read presents the credential with an HTTP message signature by that key, naming the service it is addressed to. A stolen credential is useless without the key, and a signed request for one host can't be replayed at another.

Whether the authority grants a credential is up to the space's **policy**. Cirrus implements the three baseline policies every PDS supports:

- **personalspace**: only you. For bookmarks, drafts, mutes.
- **memberspace**: a member list you manage, where each member can be allowed to read, to write, or both. It can be opened to everyone for reading (`publicRead`) or writing (`publicWrite`), and restricted to named apps (`allowedApps`, checked against client attestations).
- **managedspace**: a nominated app service is asked to decide, per user, per request.

Someone the policy refuses is told the space doesn't exist, so a refusal reveals nothing about it. A memberspace or managedspace can also publish its policy, and a memberspace its member list, as records in your own repo in the space, so readers can see who else is in it.

Writes never use credentials: they're ordinary authenticated requests to your own PDS, covered by OAuth `space:` grants or your own full-access session. App passwords are deliberately excluded.

## Proving data came from you

Space data isn't signed. Instead, your PDS has a second key, published in your DID document as `#atproto_kem`. A syncer reading your repo sends an ephemeral key with each request, both sides derive a one-off shared secret, and your PDS returns a MAC over the commit or record in an `Atproto-Space-Mac` header. The syncer knows the data is yours; but because the syncer could have computed the same MAC itself, a leaked response proves nothing to anyone else. That's the point: private data shouldn't come with a signature that lets it be passed around as authentic.

Cirrus can't serve space data to syncers without this key. `pds spaces kem` creates it; see [Enable spaces](/guides/enable-spaces/).

## Blobs

A blob referenced only from a space record is fetchable only through the credential-gated `com.atproto.space.getBlob` — never from the public `sync.getBlob`, even by someone who knows its CID. To enforce this cheaply, uploads are staged (`<did>/staged/<cid>` in R2) until a record references them, then copied to a public or per-space key. This staging applies to the public path too, flag or no flag: it closes the gap where any uploaded blob was public the moment it was uploaded.

## Isolation, by construction

Space state never touches your public repository. It lives in its own Durable Objects (one per space, plus a small index) and its own R2 prefix (`<did>/space/`). The account Durable Object — your MST, your firehose — has no space tables and no space code paths.

This is what makes the alpha safe to run: when an alpha build breaks the schema, the space Durable Objects refuse to open and every space endpoint returns a clear error, while your public repo and firehose carry on untouched. Recovery is one command:

```bash
pds spaces reset
```

which deletes all space data — and *can only* delete space data. There is no migration between alpha schema versions, matching the upstream policy.

## Alpha caveats

- **Interop is the point, stability is not.** Cirrus targets the reference alpha PDS and apps like bulletin.my. Expect breaking changes; expect `pds spaces reset` to be part of upgrading.
- **Migration is new.** The protocol can now move space data between hosts: `pds spaces export` writes each space repo as a STAR archive (and, for spaces you own, the space's policy, members and writers as a space meta archive), which `com.atproto.space.importSpaceMeta` and `importRepo` accept on the new host. Notification registrations, revoked credentials and deleted-space tombstones don't move. Nothing migrates *between alpha builds*: that's still `pds spaces reset`.
- **Access control, not encryption.** Space data is not encrypted at rest beyond what R2 and Durable Object storage already do. Your PDS (and any space host) can read what it stores.
- **Pinned dependencies.** The `@atproto/space` and `@atproto/oauth-scopes` alpha builds are pinned exactly and excluded from automatic updates. `@atproto/space` and its alpha dependencies are bundled into `@getcirrus/spaces`, because several of them have broken releases that would otherwise be installed in their place.
