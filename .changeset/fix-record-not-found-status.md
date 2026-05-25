---
"@getcirrus/pds": patch
---

Align `com.atproto.repo.getRecord` and `com.atproto.repo.deleteRecord` error handling with the reference @atproto PDS:

- `getRecord` now returns HTTP 400 (not 404) with `RecordNotFound` when the record is missing. The reference PDS raises `InvalidRequestError`, which maps to 400.
- `deleteRecord` on a missing record is now a 200 no-op (returning an empty body with no commit) instead of `RecordNotFound`, matching the reference PDS.
