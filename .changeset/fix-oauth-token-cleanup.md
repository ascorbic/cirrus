---
"@getcirrus/pds": patch
---

Fix OAuth token cleanup deleting non-revoked tokens after access token expiry

The cleanup query was deleting tokens where `revoked = 0` (non-revoked) after the access token expired. This broke refresh token flows because the token row was removed from the database before the client could use the refresh token to get a new access token. Changed to only clean up `revoked = 1` tokens, so non-revoked sessions persist until explicitly revoked or replaced by token rotation.
