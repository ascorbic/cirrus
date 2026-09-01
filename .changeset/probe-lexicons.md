---
"@getcirrus/space-conformance": patch
---

Probe spaces now use published, resolvable lexicons (`earth.cirrus.check.space` / `.note` / `.withblob`) instead of the unpublished `app.bsky.group` type and unresolvable `test.conformance.*` collections, so the suite works against implementations that resolve lexicons dynamically and validate strictly — not only against lenient targets.
