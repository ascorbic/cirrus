---
"@getcirrus/pds": patch
---

Store uploaded blobs from the stateless Worker instead of the account Durable Object.

`uploadBlob` routed the blob through the AccountDurableObject, which computed the CID and did the R2 put inside the DO. That DO is single-threaded and also holds the relay's `subscribeRepos` firehose WebSocket; awaiting an R2 put inside it pins the input gate (R2 latency is independent of object size — even a small link-card image can stall), and Cloudflare resets the object with "Durable Object storage operation exceeded timeout", dropping the firehose connection and leaving the relay desynced until a manual `requestCrawl`.

The Worker now computes the CID and writes to R2 directly (mirroring the existing `getBlob` download path) and only calls the DO for the small `imported_blobs` tracking row.
