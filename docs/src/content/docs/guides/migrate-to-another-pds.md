---
title: Migrate to another PDS
description: Move an account off Cirrus to a different PDS implementation while keeping the DID and the followers.
---

Migration away from Cirrus is performed by the target PDS, or a tool such as [PDS Moover](https://pdsmoover.com/); Cirrus generates a short-lived token that authorises the transfer.

This guide covers the Cirrus side of the operation. The target PDS's documentation covers the import side.

## When to do this

Reasons to migrate away from Cirrus include:

- Switching to a multi-user or organisational PDS.
- Moving off Cloudflare to a self-managed host.

The DID and the followers transfer. The account experience on Bluesky does not change.

## Generate the migration token

Cirrus issues a stateless migration token signed with the account's signing key. The target PDS or tool may mention this as being emailed, but Cirrus uses the CLI not email. The token authorises the target PDS to export the repository and rotate the DID.

```bash
pnpm pds migrate-token
```

The CLI prints a token that is valid for 15 minutes. Pass it to the target PDS's migration tool.

The token is one of:

- A bearer token for the target's import endpoint.
- A signed authorisation that the target presents to Cirrus when reading the repository.

The exact use depends on the target PDS's migration flow.

## Run the import on the target

Follow the target PDS's documentation for the import. The standard flow is:

1. Create a new account on the target PDS (inactive).
2. Run the target's import command, pointing at the Cirrus PDS hostname and supplying the migration token.
3. The target fetches the repository (`com.atproto.sync.getRepo`) and all blobs (`com.atproto.sync.listBlobs` + `com.atproto.sync.getBlob`).
4. The target initiates the PLC rotation.

If the target is a Bluesky reference PDS, the import takes a few minutes for a typical account.

## Rotate the DID

The PLC rotation is performed by the target PDS, not by Cirrus. The Cirrus signing key co-signs the PLC operation that hands authority over to the new key.

`pds migrate-token` includes the data needed for this. The target PDS prompts for the token during its import flow.

## Deactivate on Cirrus

Once the PLC operation lands, the network points at the new PDS. Deactivate the account on Cirrus to stop serving stale data:

```bash
pnpm pds deactivate
```

This sets the account status to inactive. The Worker still responds to `describeServer` and identity probes, but write operations are rejected.

## After the move

The Cirrus deployment is still consuming Cloudflare resources. To shut it down completely:

1. Delete the Worker from the Cloudflare dashboard.
2. Delete the R2 bucket (or keep it as a blob archive).
3. Remove the DNS records pointing at the Worker.

Keep a backup of the final repository CAR file and the signing key. Both can be useful if the migration needs to be reversed. Export the CAR before deactivating:

```bash
curl "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=<did>" > backup.car
```

## If the target import fails

The migration token expires after 15 minutes. Generate a new one with `pds migrate-token` and restart the target's import.

If the PLC rotation fails after the repository transfer, the account is in a half-migrated state: the data is on both PDSes, the DID still points at Cirrus. Re-run the target PDS's PLC step. If that is not possible, deactivate the target and continue using Cirrus.

For deeper recovery, see [Troubleshoot common errors](/guides/troubleshoot/).
