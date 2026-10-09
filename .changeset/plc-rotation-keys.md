---
"@getcirrus/pds": minor
---

Migrating a `did:plc` account with `pds identity` now gives your PDS control of your identity. Previously the PDS you migrated from kept the only rotation key, so Cirrus couldn't sign changes to your DID: it couldn't change your handle or rotate its signing key, and migrating away from Cirrus failed at the PLC directory. `pds identity` now makes your PDS's signing key a rotation key, removes the previous PDS's key, and offers to create a recovery key that ranks above it. The recovery key works with `goat` if you ever need to recover your identity without your PDS.

Accounts that were already migrated can run the new `pds rotation-keys` command to fix this. The change can be signed by your previous PDS (with your password there and an email code), by a rotation key you hold, or by your PDS once it is a rotation key. `pds status` now reports whether your PDS can update your identity, and outbound migration explains the problem instead of failing at the PLC directory.

`pds identity --token` also works now. It previously skipped the login that signing needs.
