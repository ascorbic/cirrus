---
"@getcirrus/pds": patch
---

`com.atproto.repo.applyWrites` now accepts batches that touch the same rkey more than once, matching the reference PDS. The common case is a create followed by a delete on the same rkey within one batch (an atomic no-op pattern several clients rely on); previously Cirrus rejected this with `400 InvalidRequest: duplicate rkey in batch`. Two creates on the same rkey still fail, but now as `409 RecordAlreadyExists` from the repo layer rather than a pre-flight 400.
