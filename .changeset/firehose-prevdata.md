---
"@getcirrus/pds": patch
---

Include `prevData` in firehose `#commit` events.

`prevData` is the MST root CID of the previous commit (the `data` field at the `since` rev) and is effectively required for the inductive version of the firehose. Without it, relays running strict commit validation (e.g. indigo with `LenientSyncValidation` off) fail verification with "missing prevData field" and reject every commit after the first, freezing the repo on that relay. It is now populated from the pre-write repo's `commit.data` at each write path.
