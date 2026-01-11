---
"@getcirrus/pds": minor
---

Add migrate-out token generation for account migration

Adds `pds migrate-token` CLI command that generates stateless HMAC-based migration tokens for users wanting to migrate their account to another PDS. Tokens are valid for 15 minutes and require no database storage.
