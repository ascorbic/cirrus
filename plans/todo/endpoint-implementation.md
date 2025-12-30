# AT Protocol PDS - Endpoint Implementation Status

**Status:** 📋 Planning Document

This document tracks the implementation status of all AT Protocol XRPC endpoints and prioritizes future work.

## Implementation Summary

**Total Core PDS Endpoints: 70**
- ✅ **Implemented: 26** (37%)
- ⚠️ **Partial/Stub: 3** (4%)
- ❌ **Not Implemented: 41** (59%)

**For Single-User PDS:**
- **Necessary endpoints implemented: 26/~30** (87%)
- Most missing endpoints are multi-user, admin, or moderation features

## Currently Supported Endpoints

### com.atproto.repo (9/11 - 82%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `applyWrites` | ✅ Complete | Batch operations, validates all records |
| `createRecord` | ✅ Complete | Validates against lexicon schemas |
| `deleteRecord` | ✅ Complete | Updates firehose |
| `describeRepo` | ✅ Complete | Returns collections and DID document |
| `getRecord` | ✅ Complete | With CID and value |
| `importRepo` | ✅ Complete | CAR file import with validation |
| `listRecords` | ✅ Complete | Pagination, cursor, reverse |
| `putRecord` | ✅ Complete | Create or update with validation |
| `uploadBlob` | ✅ Complete | 5MB limit, R2 storage |

### com.atproto.sync (6/11 - 55%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `getBlob` | ✅ Complete | Direct R2 access |
| `getRepo` | ✅ Complete | CAR file export |
| `getRepoStatus` | ✅ Complete | Active status, rev, head |
| `listBlobs` | ✅ Complete | Paginated blob listing |
| `listRepos` | ✅ Complete | Returns single repo (single-user) |
| `subscribeRepos` | ✅ Complete | WebSocket firehose with CBOR frames |

### com.atproto.server (7/26 - 27%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `createSession` | ✅ Complete | JWT + static token auth |
| `deleteSession` | ✅ Complete | Stateless (client-side) |
| `describeServer` | ✅ Complete | Server capabilities |
| `getAccountStatus` | ✅ Complete | Migration support |
| `getServiceAuth` | ✅ Complete | Service JWTs for AppView/external services |
| `getSession` | ✅ Complete | Current session info |
| `refreshSession` | ✅ Complete | Token refresh with validation |

### com.atproto.identity (1/6 - 17%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `resolveHandle` | ⚠️ Partial | Complete implementation (DNS + HTTPS for any handle) |

### app.bsky.* (3 endpoints)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `actor.getPreferences` | ✅ Complete | Persists to SQLite |
| `actor.putPreferences` | ✅ Complete | Persists to SQLite |
| `ageassurance.getState` | ✅ Stub | Returns "assured" (self-hosted = pre-verified) |

## TODO Endpoints (Grouped by Priority)

### Account Lifecycle (P1 - Critical for Migration)

For the deactivated account pattern (see `migration-wizard.md`):

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `activateAccount` | Transition deactivated → active | Enables writes, firehose |
| `deactivateAccount` | Transition active → deactivated | Disables writes |
| Enhanced `getAccountStatus` | Return activation state | Add `activated`, `imported` fields |

**Deactivation guards needed:**
- Block writes (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`) when deactivated
- Allow reads, `importRepo`, `uploadBlob`, `activateAccount`

**Total: 2 new endpoints + 1 enhancement**

### App Passwords (P2 - Important)

| Endpoint | Purpose |
|----------|---------|
| `createAppPassword` | Create app-specific revocable passwords |
| `listAppPasswords` | List all app passwords |
| `revokeAppPassword` | Revoke specific app password |

**Total: 3 endpoints**

### Advanced Sync (P3 - Nice to Have)

| Endpoint | Purpose |
|----------|---------|
| `getBlocks` | Get specific blocks by CID |
| `getLatestCommit` | Get latest commit without full repo |
| `getRecord` (sync) | Get record with merkle proof |

**Total: 3 endpoints**

## Not Implementing

### createAccount

**Reason:** Account creation happens at deploy time, not via API.

For migration: DID set in env vars, data imported via `importRepo`.
For new accounts: Deploy script generates DID, publishes to PLC.

May revisit if tools like Goat require it.

### PLC Operation Endpoints

| Endpoint | Reason |
|----------|--------|
| `getRecommendedDidCredentials` | Not needed - keys generated at deploy |
| `requestPlcOperationSignature` | Handled by old PDS during migration |
| `signPlcOperation` | Handled by old PDS during migration |
| `submitPlcOperation` | Handled by old PDS during migration |

PLC operations for migration are performed against the **old** PDS, not the new one.

### Multi-User Administration (14 endpoints)

**Reason:** Single-user PDS has no admin/user separation

All `com.atproto.admin.*` endpoints

### Moderation (1 endpoint)

**Reason:** Single-user PDS doesn't need moderation infrastructure

- `com.atproto.moderation.createReport`

### Account Creation & Invites (5 endpoints)

**Reason:** Single-user PDS is pre-configured

- `createInviteCode`
- `createInviteCodes`
- `getAccountInviteCodes`
- `checkSignupQueue`

### Email Verification & Recovery (6 endpoints)

**Reason:** Single-user PDS has no email system

- `confirmEmail`
- `requestEmailConfirmation`
- `requestEmailUpdate`
- `updateEmail`
- `requestPasswordReset`
- `resetPassword`

### Deprecated (2 endpoints)

- `com.atproto.sync.deprecated.getCheckout`
- `com.atproto.sync.deprecated.getHead`

## Proxy Strategy

All unimplemented `app.bsky.*` endpoints are proxied to `api.bsky.app` with service auth. This includes:
- Feeds (`app.bsky.feed.*`)
- Graphs (`app.bsky.graph.*`)
- Notifications (`app.bsky.notification.*`)
- Labels (`app.bsky.labeler.*`)
- Chat (`chat.bsky.*`)

This is intentional - the edge PDS focuses on repository operations and federates view/aggregation to AppView.

## Implementation Phases

### Phase 1: Account Lifecycle (2 endpoints)

Enable deactivated account pattern for migration:
- `activateAccount`
- `deactivateAccount`
- Deactivation guards on write operations

### Phase 2: OAuth Provider

Enable ecosystem compatibility with "Login with Bluesky" apps.
See `oauth-provider.md` for detailed specification.

### Phase 3: App Passwords (3 endpoints)

Multi-device auth with revocable app passwords.

### Phase 4: Advanced Sync (3 endpoints)

Efficient partial sync and merkle proofs.

## Endpoint Coverage by Namespace

| Namespace | Supported | Total | Coverage |
|-----------|-----------|-------|----------|
| `com.atproto.repo` | 9 | 11 | 82% |
| `com.atproto.sync` | 6 | 11 | 55% |
| `com.atproto.server` | 7 | 26 | 27% |
| `com.atproto.identity` | 1 | 6 | 17% |
| `com.atproto.admin` | 0 | 14 | 0% (intentional) |
| `app.bsky.*` | 3 | - | Proxy model |

## References

- [AT Protocol Specs](https://atproto.com/specs)
- [Official PDS Implementation](https://github.com/bluesky-social/atproto/tree/main/packages/pds)
- [Account Migration Guide](https://atproto.com/guides/account-migration)
