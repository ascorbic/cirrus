---
"@getcirrus/pds": patch
---

Address the service-auth JWT for `app.bsky.feed.getFeed` to the feed generator rather than the AppView. The token is now stamped with `aud` set to the generator's service DID (resolved from the feed record) and `lxm` set to `app.bsky.feed.getFeedSkeleton`, matching the reference PDS implementation. Previously the token carried `aud: did:web:api.bsky.app`, so generators that validate the audience (such as the Bluesky "For You" feed) rejected it and ran in a degraded, stateless mode — feeds appeared stuck because per-user "seen" state was never recorded. If the feed record can't be resolved, the request falls back to ordinary AppView proxying so the feed still loads.
