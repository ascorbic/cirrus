---
"@getcirrus/oauth-provider": patch
---

Fix CSP blocking OAuth form submission in some browsers

The `form-action 'self'` CSP directive was blocking form submissions during OAuth authorization in some browser configurations. This change makes the CSP dynamic by explicitly including the issuer URL alongside `'self'` to ensure cross-browser compatibility.
