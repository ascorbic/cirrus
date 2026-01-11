---
"@cirrus/pds": minor
---

Add `pds identity` command for seamless PLC migration

When migrating from another PDS (like bsky.social), this new command handles the PLC directory update:

- Requests a PLC operation signature from your source PDS via email token
- Signs the operation with your new Cirrus signing key
- Submits the signed operation to plc.directory

This streamlines the migration flow – run `pds migrate`, then `pds identity`, then `pds activate`.
