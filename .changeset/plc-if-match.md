---
"@getcirrus/pds": patch
---

PLC update operations are submitted with `If-Match: *`, from both the PDS (`com.atproto.identity.submitPlcOperation`, used by `pds spaces kem --publish`, `pds rotation-keys` and migrations) and the CLI. This tells plc.directory that the DID already exists, so the update is rate-limited per identifier rather than per IP, which matters on Workers, whose egress IPs are shared by many sites. Genesis operations never carry the header. Directories that predate it ignore it.
