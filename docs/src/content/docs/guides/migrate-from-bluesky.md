---
title: Migrate from Bluesky
description: Move an existing Bluesky-hosted account to Cirrus, including the DID rotation and the firehose hand-off.
---

This guide moves an existing account from `bsky.social` (or any other PDS) to a Cirrus deployment. The account keeps its DID, its followers, its posts, and its handle.

## Before starting

Make sure the following are in place:

- A Cirrus deployment that has run `pds init` and been deployed to Cloudflare. See [Quick start](/start/quick-start/).
- Access to the email address registered with the Bluesky account.
- The current Bluesky handle and password.
- A backup of the new signing key generated during `pds init`.

The source account stays usable throughout the migration. The migration can be paused and resumed; the CLI keeps a checkpoint.

## What migration does

The migration performs, in order:

1. Creates an inactive account on the target Cirrus PDS.
2. Exports the repository and all blobs from the source PDS.
3. Imports them into the target PDS.
4. Submits a PLC operation to point the DID document at the new PDS and signing key.
5. Activates the account on the target PDS and deactivates it on the source.

Once step 4 lands, the network's view of the account points at Cirrus.

## Run the migration

From the Cirrus project directory:

```bash
pnpm pds migrate
```

The handle and DID come from `wrangler.jsonc` (set by `pds init` when migration was chosen). The CLI resolves the source PDS automatically from the DID document, so the only prompt is:

- The current Bluesky password.

It then runs the transfer. The CLI shows progress for the repository import, the blob transfer (which is the slowest part), and the firehose sequencing.

If the process is interrupted, run `pds migrate` again. It picks up from the last checkpoint. Use `--clean` to discard the checkpoint and start fresh.

## Rotate the DID

After the repository and blobs are transferred, the CLI prompts for the PLC operation:

```bash
pnpm pds identity
```

Bluesky issues `did:plc`, so every migrating account uses PLC. `pds identity` only handles `did:plc` accounts.

This:

1. Requests an email confirmation token from Bluesky.
2. Asks Bluesky's PDS to sign the PLC operation with its key.
3. Submits the signed operation to the PLC directory.

The wizard shows the email token prompt and waits for the code. The email arrives at the address registered with the Bluesky account.

Once the PLC operation lands, the DID document points at the Cirrus PDS and the new signing key. The network resolves the account to the new PDS within seconds.

## Activate and verify

Activate the account on Cirrus:

```bash
pnpm pds activate
```

Then run `pds status` to confirm:

- Handle resolves to the DID.
- DID document points at the Cirrus hostname.
- Repository is initialised with the expected revision.
- Blob count matches the source.

Open the Bluesky app and sign in with the existing handle and the new password set during `pds init`. The timeline, follows, and notifications appear as before.

## After migration

The source PDS still has the account state, but it is no longer the authoritative PDS for the DID. Bluesky deactivates the source account automatically once the PLC operation lands.

Emit an identity event to notify relays of the change:

```bash
pnpm pds emit-identity
```

This is optional in most cases (relays pick up the PLC change naturally) but accelerates the firehose hand-off.

## If something goes wrong

**The CLI fails partway through the import.** Re-run `pds migrate`. The checkpoint resumes from the last successful step.

**The PLC operation fails.** The email token is single-use; if it expires, request a new one and re-run `pds identity`.

**The account is unreachable after the rotation.** Check that the Cirrus deployment is live (`curl https://pds.example.com/xrpc/com.atproto.server.describeServer`). Check the DID document at `https://plc.directory/<did>`. If the DID document points at Cirrus but the PDS is unreachable, fix the PDS. If the DID document still points at Bluesky, the PLC operation did not land — re-run `pds identity`.

For all other failures, see [Troubleshoot common errors](/guides/troubleshoot/).
