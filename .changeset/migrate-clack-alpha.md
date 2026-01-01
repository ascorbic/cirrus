---
"@ascorbic/pds": minor
"create-pds": minor
---

Upgrade CLIs to @clack/prompts alpha with enhanced UX features

- **Progress bar**: Replace custom progress rendering with clack's built-in `progress()` API for blob transfers
- **Info boxes**: Replace ANSI escape hacks with native `box()` prompt supporting title alignment and better formatting
- **Task logging**: Add `taskLog()` for transient setup steps that clear on success (secret generation, project setup)
- **Error states**: Use `spinner.error()` for failure cases providing clearer visual distinction
- **Polished UX**: Focus on reassurance during operations and delight with clean, professional output
