---
"@getcirrus/pds": patch
"@getcirrus/spaces": patch
"@getcirrus/space-conformance": patch
---

Fix fresh installs failing with `"@atproto/lex-data@workspace:*" is in the dependencies but no package named "@atproto/lex-data" is present in the workspace` (or `Unsupported URL Type "workspace:"` under npm). This affected new projects created with `create-pds`, as well as any project installing these packages without an existing lockfile.
