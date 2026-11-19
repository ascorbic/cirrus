---
"@getcirrus/pds": patch
---

`pds init` can now find accounts with hosted handles such as `*.bsky.social` when migrating. It only looked for a DNS TXT record, which those handles don't have, so it reported "Failed to resolve handle". The CLI now also checks `/.well-known/atproto-did`, which also fixes the handle checks in `pds activate` and `pds deactivate`.
