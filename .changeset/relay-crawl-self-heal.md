---
"@getcirrus/pds": minor
---

The PDS now re-adds itself to the relay's crawl list automatically. When a write commits while no relay is subscribed to the firehose, it sends `com.atproto.sync.requestCrawl` to the configured relays — rate-limited, and without delaying the write. Previously a relay that had marked the host offline would silently stop federating your posts until someone requested a crawl by hand. Relays default to `https://bsky.network` and can be overridden with the optional comma-separated `RELAYS` environment variable.
