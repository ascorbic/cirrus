---
"@getcirrus/pds": patch
---

Normalize JSON blob references for correct dag-cbor encoding

Incoming API records contain blob references with nested `$link` objects
(for example, `{ "$type": "blob", "ref": { "$link": "bafk..." } }`). These
must be converted to actual CID instances before CBOR encoding, otherwise
the blob ref's `ref` field gets encoded as a map instead of a proper CID tag.
This causes incorrect block hashes, which can lead to blob resolution failures
on the Bluesky network.

Uses `jsonToLex` from `@atproto/lexicon` to convert `$link` → CID and
`$bytes` → Uint8Array on all record write paths (createRecord, putRecord,
applyWrites).
