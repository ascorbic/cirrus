---
"@getcirrus/pds": patch
---

Fix relay desync after a failed write (e.g. an image post that errors mid-flight).

`applyWrites` was assigning the new `Repo` to in-memory state before sequencing the firehose event. If anything threw between then and `sequenceCommit` succeeding, Cloudflare rolled back the SQLite writes but the in-memory `Repo` stayed advanced. The next successful write then emitted a firehose commit whose `since` rev the relay had never seen, and the relay marked the repo desynced — requiring a manual `requestCrawl` to recover.

`this.repo` is now only assigned after the sequence + broadcast succeed, and any failure in that window invalidates the in-memory cache so the next access reloads from storage.
