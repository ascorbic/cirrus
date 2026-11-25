---
"@getcirrus/pds": minor
"@getcirrus/spaces": minor
---

Update atproto spaces to the 2026-11-24 alpha (`0.0.0-spaces-alpha-20261124235736`). This is a breaking alpha change: the space schema moves to version 4, so run `pds spaces reset` after deploying and recreate your spaces.

- Spaces are addressed as `at:space/{did}/{type}/{key}` (and records in them as `at:space/{did}/{type}/{key}/{author}/{collection}/{rkey}`) instead of `at://{did}/space/…`, in every request and response, token and archive. The old form is refused. Archives exported before this release no longer import, and apps, syncers and other hosts on earlier alphas can't interoperate with this one.
- App-password sessions are refused on space methods with `400 InvalidToken`, as the reference PDS refuses them.
- `com.atproto.space.importRepo` through OAuth needs a `space:` grant covering every collection of the space (`collection=*`), not just the archive's.
- The alpha `@atproto` packages now depend on each other at exact versions, so the workspace overrides for their broken releases are gone.
