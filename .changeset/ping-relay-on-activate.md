---
"@getcirrus/pds": minor
---

Ping the Bluesky relay on account activation. The `pds activate` command now calls `com.atproto.sync.requestCrawl` on bsky.network to notify the relay that the PDS is ready for federation. If the account is already active, running `pds activate` again will offer to retry notifying the relay.
