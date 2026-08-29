---
"@getcirrus/spaces": minor
---

First release of `@getcirrus/spaces`: the atproto spaces engine (alpha) for Cloudflare Workers. Provides the per-space and index Durable Objects, permissioned repo storage with LtHash commits and oplog sync, space credential / delegation / DPoP / client-attestation verification, simplespace policies, and the Hono route factory for `com.atproto.space.*` and `com.atproto.simplespace.*`, all behind the host PDS's `SPACES_ENABLED` flag.
