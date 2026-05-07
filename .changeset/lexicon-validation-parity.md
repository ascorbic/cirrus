---
"@getcirrus/pds": minor
---

Lexicon validation now matches the reference PDS more closely:

- `createRecord`, `putRecord`, and `applyWrites` honor the `validate` flag from the request body. `true` requires a known schema, `false` skips schema validation, `undefined` validates known schemas optimistically.
- Responses include `validationStatus` (`"valid"` for known, `"unknown"` for unknown collections; omitted when `validate: false`). Per-write `validationStatus` is returned in `applyWrites` results.
- The record's `$type` is filled in from `collection` when missing and rejected on mismatch.
- Generic record-key shape (`isRecordKey`) is enforced for any provided rkey, regardless of `validate` flag — closes a hole where empty-string and path-traversal-style rkeys could reach the repo.
- Schema-specific record keys are validated against the schema's `keySchema` for known collections (e.g. `app.bsky.feed.post` requires a TID, `app.bsky.actor.profile` requires `self`).
- Legacy `{ cid, mimeType }` blob refs are rejected.
- Bundled schema set broadened to include `com.atproto.lexicon.schema`, `app.bsky.actor.status`, `app.bsky.notification.declaration`, and `chat.bsky.actor.declaration`.
- The Durable Object is now the authoritative rkey allocator: when the client doesn't supply an rkey, the worker validates against a candidate (so restrictive `keySchema`s still reject early) and the DO picks the final rkey against its MST state, with a small retry loop to defeat any worker-isolate clockid collisions.
- Client-supplied rkey collisions return `409 RecordAlreadyExists` instead of a generic 500.
- Intra-batch duplicate rkeys in `applyWrites` return `400 InvalidRequest` (distinguished from the 409 above).
- Missing rkey for `applyWrites#update`/`#delete` returns `400 InvalidRequest`.
- Non-boolean `validate` flag values return `400 InvalidRequest`.
- Non-string `rkey` values (including `null`) return `400 InvalidRequest`.
