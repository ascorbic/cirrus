---
"@getcirrus/pds": patch
---

Match the reference @atproto PDS's exact `RecordNotFound` error message (`Could not locate record: <at-uri>`). The Bluesky social-app's quote-detach flow string-matches this phrase to decide whether to create a new `app.bsky.feed.postgate` record vs. update an existing one; the previous message caused it to rethrow instead of falling through to the create path.
