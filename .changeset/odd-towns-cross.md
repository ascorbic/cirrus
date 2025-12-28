---
"@ascorbic/pds": patch
"create-pds": patch
---

Fix signing key serialization format and improve CLI

- Fix signing key export to use hex encoding instead of JSON (was causing import failures)
- Add `@types/node` to create-pds template
- Suppress install and wrangler types output unless there's an error
- Add initial git commit after install, and commit after pds init
- Extract shared secret generation utilities for CLI commands
- Add tests for signing key serialization
