---
"@ascorbic/pds": patch
---

Return HTTP 403 with AccountDeactivated error for write operations on deactivated accounts

Previously, attempting write operations on a deactivated account returned a generic 500 error. Now returns a proper 403 Forbidden with error type "AccountDeactivated", giving clients clear feedback that the account needs to be activated.
