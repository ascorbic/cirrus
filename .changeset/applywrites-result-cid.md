---
"@getcirrus/pds": patch
---

`applyWrites` now returns the record CID on `createResult` and `updateResult` even when the record is removed later in the same batch. The lexicon marks `cid` as required, but the previous code looked it up in the post-commit MST — for a record that was created then deleted within one batch, the MST has no entry and the field was missing. The CID is now computed from the record bytes up front, matching reference PDS behaviour.
