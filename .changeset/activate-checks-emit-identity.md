---
"@getcirrus/pds": minor
---

Add pre-activation checks and emit-identity command

**activate command improvements:**
- Run identity checks before activation (handle resolution, DID document, repo status)
- Display clear results table with pass/fail status
- Require confirmation if checks fail (skip with `--yes`)
- Verify activation succeeded after calling the endpoint
- Offer to emit identity event if all checks passed
- Add `--yes` / `-y` flag to skip confirmation prompts

**deactivate command improvements:**
- Run identity checks to inform user of current state before deactivating
- Add `--yes` / `-y` flag to skip confirmation prompts

**New emit-identity command:**
- Standalone `pds emit-identity` command to notify relays to refresh handle verification
- Useful after migration or handle changes

**Internal changes:**
- Moved emit identity endpoint from `/admin/emit-identity` to XRPC namespace `gg.mk.experimental.emitIdentityEvent`
