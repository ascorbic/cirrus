---
"@getcirrus/oauth-provider": patch
---

PAR (`/oauth/par`) now validates `redirect_uri` against the client's registered redirect_uris at push time. Previously the check only ran at the authorize step, which let a malicious caller obtain a `request_uri` for an unregistered redirect even though the subsequent authorize would have rejected it. Reject early per RFC 6749 §3.1.2.4.
