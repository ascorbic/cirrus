# Allowlist / Waitlist for fid.is Account Creation

## Status: Complete

Gate on account creation: only FIDs on an allowlist can create accounts. Everyone else sees an "Early Access" screen with a "Request Access" button that adds them to a waitlist. The feature is controlled by the `ALLOWLIST_ENABLED` env var — when absent or `"false"`, everyone is allowed.

## Design

- **Feature flag**: `ALLOWLIST_ENABLED` env var in `wrangler.jsonc` (`"true"` to enable)
- **`is.fid.account.status`** returns `{ fid, exists, allowed, waitlisted }` — no extra roundtrip
- **Existing accounts are never blocked** — the gate only applies to new account creation
- **`is.fid.waitlist.join`** endpoint for requesting access (authenticates via Quick Auth or SIWF)
- **D1 tables** (`allowlist` + `waitlist`) in the `USER_REGISTRY` database
- **Admin via D1 CLI** — no admin UI

## Files Changed

| File | Change |
|---|---|
| `apps/fid-pds/schema.sql` | `allowlist` and `waitlist` tables |
| `packages/pds/src/user-registry.ts` | `isAllowed()`, `isWaitlisted()`, `joinWaitlist()` |
| `packages/pds/src/types.ts` | `ALLOWLIST_ENABLED` in `PDSEnv` |
| `packages/pds/src/xrpc/fid-account.ts` | Extended `getAccountStatus`, guarded creation, added `joinWaitlist` handler |
| `packages/pds/src/index.ts` | Route for `is.fid.waitlist.join`, new exports |
| `apps/miniapp/src/api.ts` | Updated `getAccountStatus` return type, added `joinWaitlistApi()` |
| `apps/miniapp/src/App.tsx` | Added `waitlist` state + `WaitlistScreen` component |
| `apps/fid-pds/wrangler.jsonc` | `ALLOWLIST_ENABLED: "true"` |

## Admin Operations

### Add a FID to the allowlist

```bash
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) VALUES ('12345', 'admin')"
```

### Add multiple FIDs at once

```bash
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) VALUES ('111', 'admin'), ('222', 'admin'), ('333', 'admin')"
```

### Approve all waitlisted users

```bash
wrangler d1 execute fid-pds-registry --command \
  "INSERT OR IGNORE INTO allowlist (fid, added_by) SELECT fid, 'batch' FROM waitlist"
```

### View the waitlist

```bash
wrangler d1 execute fid-pds-registry --command \
  "SELECT * FROM waitlist ORDER BY requested_at"
```

### View the allowlist

```bash
wrangler d1 execute fid-pds-registry --command \
  "SELECT * FROM allowlist ORDER BY added_at"
```

### Check if a specific FID is allowed/waitlisted

```bash
wrangler d1 execute fid-pds-registry --command \
  "SELECT 'allowed' AS status FROM allowlist WHERE fid = '12345' UNION ALL SELECT 'waitlisted' FROM waitlist WHERE fid = '12345'"
```

### Disable the feature (open to everyone)

Set `ALLOWLIST_ENABLED` to `"false"` (or remove it) in `apps/fid-pds/wrangler.jsonc`, then redeploy.

### Run the D1 migration (first-time setup)

```bash
wrangler d1 execute fid-pds-registry --file=schema.sql
```
