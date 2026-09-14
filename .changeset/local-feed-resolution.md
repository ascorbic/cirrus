---
"@getcirrus/pds": patch
---

Resolve feed-generator records published by the PDS account directly from its local repository. This avoids public self-fetches that can time out on same-zone Cloudflare Worker routes, while preserving remote-feed resolution and existing fallback behavior.
