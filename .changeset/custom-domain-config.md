---
"@getcirrus/pds": minor
---

Add custom domain configuration to `pds init`. Users are now prompted to configure Cloudflare custom domain routing, which sets up the wrangler.jsonc routes config with `custom_domain: true`. On deploy, Cloudflare will automatically configure DNS records and SSL certificates.
