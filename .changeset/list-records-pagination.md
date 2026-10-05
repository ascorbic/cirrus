---
"@getcirrus/pds": minor
---

Fix `com.atproto.repo.listRecords` pagination. Following the cursor returned the record at each page boundary up to three times, and with `reverse=true` or `limit=2` the cursor never advanced, so clients that paged until the cursor ran out looped forever.

Records are now listed newest first by default and oldest first with `reverse=true`, matching the reference PDS (the order was previously the other way round). The cursor is now the bare rkey of the last record, as in the reference PDS; cursors in the old `collection/rkey` form are still accepted. `limit` is clamped to 1–100, and listing a collection with no records no longer scans the rest of the repository.
