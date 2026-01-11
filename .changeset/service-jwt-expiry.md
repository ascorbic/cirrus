---
"@getcirrus/pds": patch
"create-pds": patch
---

Fix service JWT expiry for video uploads

Extended the service JWT expiry from 60 seconds to 5 minutes. This fixes video upload failures where larger videos would take longer than 60 seconds to process on video.bsky.app, causing the callback to your PDS to fail with 401 due to the expired JWT.

Also enables observability in the Cloudflare Worker template for better debugging.
