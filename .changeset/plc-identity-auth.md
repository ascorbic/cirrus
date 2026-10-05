---
"@getcirrus/pds": patch
---

Signing PLC operations (`com.atproto.identity.signPlcOperation`) and generating migration tokens now require your account password, the `AUTH_TOKEN`, or an OAuth grant that includes `identity:*`. App passwords, OAuth tokens without that permission, and service auth tokens are refused. Previously any signed-in app could request a migration token and have your PDS sign a change to your identity.
