---
"@getcirrus/pds": patch
---

Respect user's package manager choice in CLI commands. All CLI commands (init, migrate, activate, deactivate) now detect and use the user's package manager consistently. Changed `wrangler deploy` references to use the appropriate package manager command (e.g., `pnpm run deploy`).
