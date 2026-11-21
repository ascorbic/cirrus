---
"@getcirrus/spaces": patch
---

Fix client attestation verification on Workers. The client metadata and JWKS fetches used `redirect: "error"`, which workerd refuses, so every attestation failed and a memberspace with `allowedApps` refused every app. They now use `redirect: "manual"` and still reject redirects.
