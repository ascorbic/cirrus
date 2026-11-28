---
"upgrade-pds": minor
---

Add `upgrade-pds`, a command that upgrades an existing Cirrus project. Run `npx upgrade-pds@latest` in the project directory to move `@getcirrus/pds` to the latest release and get `.cirrus/UPGRADE.md`, a work order with every release entry between the installed and new versions and the build, deploy, and verification commands. It does not edit the wrangler config, set secrets, or deploy. The work order starts from the version your deployed PDS reports when that is older than the installed one. If that cannot be read, pass `--from <version>` with the `@getcirrus/pds` version the project was on to get the work order for the releases since. When a coding agent runs the command, it prints instructions for the agent in place of the confirmation prompt.
