---
"@getcirrus/pds": patch
---

Allow the `Authorization` header in cross-origin requests. Browser clients sending a bearer token were previously blocked at CORS preflight in Firefox and Safari.
