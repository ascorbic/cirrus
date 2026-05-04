---
"@getcirrus/pds": patch
---

Fix `com.atproto.server.checkAccountStatus` response to be lexicon-compliant: `privateStateValues` is a required `integer` (not nullable), so return `0` instead of `null` in both the activated and not-activated branches.
