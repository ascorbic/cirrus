# Passkey Support for Cirrus

## Overview

Add passkey (WebAuthn) authentication support with CLI-driven registration and minimal web UI.

## Architecture

### User Flow

1. **Registration:** `pds passkey add` → generates URL → user opens on device → registers passkey → CLI confirms
2. **Authentication:** OAuth login page offers passkey option alongside password

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `pds passkey add` | CLI | Initiate registration, generate token, output URL |
| `pds passkey list` | CLI | Show registered passkeys |
| `pds passkey remove <id>` | CLI | Remove a passkey |
| `/passkey/register?token=xxx` | Worker | Minimal web page for WebAuthn ceremony |
| `/passkey/register` POST | Worker | Handle registration response |
| Storage | Durable Object SQLite | Store passkey credentials |

### Dependencies

**New package:** `@simplewebauthn/server` (server-side WebAuthn verification)

The browser-side WebAuthn API is native - no client library needed.

## Implementation Plan

### Phase 1: Storage Layer

**File:** `packages/pds/src/oauth-storage.ts`

Add passkey table and methods:

```sql
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
```

RPC methods to add to `AccountDurableObject`:
- `rpcSavePasskey(credentialId, publicKey, counter, name)`
- `rpcGetPasskey(credentialId)`
- `rpcListPasskeys()`
- `rpcDeletePasskey(credentialId)`
- `rpcUpdatePasskeyCounter(credentialId, counter)`

### Phase 2: Registration Token System

**File:** `packages/pds/src/passkey.ts` (new)

- Generate short-lived registration tokens (10 min expiry)
- Store in Durable Object with expiry
- Token format: `base64url(32 random bytes)`

### Phase 3: Web UI for Registration

**File:** `packages/pds/src/passkey-ui.ts` (new)

Minimal page matching existing OAuth consent UI style:
- Dark gradient background (#1a1a2e → #16213e)
- Centered card with shadow
- Single "Register Passkey" button
- Success/error states

The page:
1. Fetches registration options from server (includes challenge)
2. Calls `navigator.credentials.create()` with options
3. POSTs attestation response back to server
4. Shows success message

### Phase 4: Worker Routes

**File:** `packages/pds/src/index.ts`

New routes:
```typescript
app.get("/passkey/register", handlePasskeyRegisterPage);
app.post("/passkey/register", handlePasskeyRegisterSubmit);
```

Both routes require valid registration token in query string.

### Phase 5: CLI Commands

**File:** `packages/pds/src/cli/commands/passkey/index.ts` (new)

```
pds passkey add [--name <name>]
  - Generates registration token via authenticated request to PDS
  - Outputs URL: https://{hostname}/passkey/register?token={token}
  - Polls for completion or shows QR code

pds passkey list
  - Lists registered passkeys with name, credential ID prefix, created date

pds passkey remove <id>
  - Removes passkey by ID (with confirmation)
```

### Phase 6: OAuth Integration (Optional - Phase 2)

Update OAuth consent UI to offer passkey login when available:
- Check if passkeys exist for user
- Show "Sign in with passkey" button
- Fall back to password if needed

## File Changes Summary

### New Files
- `packages/pds/src/passkey.ts` - Registration token logic, WebAuthn verification
- `packages/pds/src/passkey-ui.ts` - HTML rendering for registration page
- `packages/pds/src/cli/commands/passkey/index.ts` - CLI command group
- `packages/pds/src/cli/commands/passkey/add.ts`
- `packages/pds/src/cli/commands/passkey/list.ts`
- `packages/pds/src/cli/commands/passkey/remove.ts`

### Modified Files
- `packages/pds/src/index.ts` - Add passkey routes
- `packages/pds/src/account-do.ts` - Add passkey storage RPC methods
- `packages/pds/src/storage.ts` - Add passkey table schema
- `packages/pds/src/cli/index.ts` - Register passkey subcommand
- `packages/pds/package.json` - Add @simplewebauthn/server dependency

## Security Considerations

1. Registration tokens are single-use and expire in 10 minutes
2. Only authenticated CLI can generate registration tokens (uses AUTH_TOKEN)
3. Passkey credentials stored securely in Durable Object
4. Counter validation prevents credential cloning attacks
5. RP ID (relying party) set to PDS_HOSTNAME for domain binding

## Testing Strategy

1. Unit tests for WebAuthn verification logic
2. CLI tests for passkey commands
3. Manual E2E testing with real devices

## Questions/Decisions

1. **Discoverable credentials?** Yes - allows conditional UI and usernameless login
2. **Attestation type?** `none` - we don't need to verify the authenticator
3. **User verification?** `preferred` - use biometrics/PIN when available
4. **Multiple passkeys?** Yes - users can register multiple devices
