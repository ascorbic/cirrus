---
"@getcirrus/oauth-provider": patch
---

Fix OAuth authentication failure for confidential clients whose JWKS contains invalid key_ops

Clients with ECDSA signing keys that incorrectly declare encryption operations (e.g. `"encrypt"`, `"wrapKey"`) in their JWKS `key_ops` field would fail with "invalid usage" during token exchange.
