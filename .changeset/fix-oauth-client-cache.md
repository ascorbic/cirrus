---
"@getcirrus/pds": patch
---

Fix OAuth client metadata caching to avoid redundant network requests

Client metadata was re-fetched from the network on every OAuth request instead of using the cache, adding latency to token exchanges and making auth fragile when client metadata endpoints are slow or unavailable.
