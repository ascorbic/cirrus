---
"@getcirrus/spaces": patch
---

The managing app's `checkAccess` call and `notifyRepoUpdate` to a space hosted elsewhere no longer follow redirects, as registration confirmation and attestation fetches already didn't: a 3xx is a failure. A redirected `checkAccess` answers `UpstreamFailure`, and a redirected `notifyRepoUpdate` is dropped rather than re-sent with its service auth to another host.
