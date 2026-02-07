---
"@getcirrus/pds": patch
---

Skip OAuth authorization for messaging platform link preview bots

Messaging platforms (Telegram, Slack, Discord, Twitter/X, Facebook/iMessage) pre-fetch URLs shared in DMs and channels. When an OAuth authorization link with a one-time PAR request URI is shared, the preview bot consumes it before the user can open it. The authorize endpoint now detects these specific bots by User-Agent and returns a minimal HTML page with appropriate meta tags instead of processing the OAuth request.

Only known messaging platform bots are matched — generic crawlers and spiders are not excluded, since an unknown bot hitting an OAuth URL should still consume the token.
