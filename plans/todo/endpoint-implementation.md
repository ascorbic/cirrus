# AT Protocol PDS - Endpoint Implementation Status

**Status:** 📋 Planning Document

This document tracks the implementation status of all AT Protocol XRPC endpoints and prioritizes future work.

## Implementation Summary

**Total Core PDS Endpoints: 70**

- ✅ **Implemented: 30** (43%)
- ⚠️ **Partial/Stub: 3** (4%)
- ❌ **Not Implemented: 37** (53%)

**For Single-User PDS:**

- **Necessary endpoints implemented: 30/~32** (94%)
- Most missing endpoints are multi-user, admin, or moderation features

## Currently Supported Endpoints

### com.atproto.repo (10/11 - 91%)

| Endpoint           | Status      | Notes                                          |
| ------------------ | ----------- | ---------------------------------------------- |
| `applyWrites`      | ✅ Complete | Batch operations, validates all records        |
| `createRecord`     | ✅ Complete | Validates against lexicon schemas              |
| `deleteRecord`     | ✅ Complete | Updates firehose                               |
| `describeRepo`     | ✅ Complete | Returns collections and DID document           |
| `getRecord`        | ✅ Complete | With CID and value                             |
| `importRepo`       | ✅ Complete | CAR file import with validation, blob tracking |
| `listMissingBlobs` | ✅ Complete | Lists blobs referenced but not imported        |
| `listRecords`      | ✅ Complete | Pagination, cursor, reverse                    |
| `putRecord`        | ✅ Complete | Create or update with validation               |
| `uploadBlob`       | ✅ Complete | 5MB limit, R2 storage, tracks imports          |

### com.atproto.sync (7/11 - 64%)

| Endpoint         | Status      | Notes                                  |
| ---------------- | ----------- | -------------------------------------- |
| `getBlob`        | ✅ Complete | Direct R2 access                       |
| `getBlocks`      | ✅ Complete | Returns CAR file with requested blocks |
| `getRepo`        | ✅ Complete | CAR file export                        |
| `getRepoStatus`  | ✅ Complete | Active status, rev, head               |
| `listBlobs`      | ✅ Complete | Paginated blob listing                 |
| `listRepos`      | ✅ Complete | Returns single repo (single-user)      |
| `subscribeRepos` | ✅ Complete | WebSocket firehose with CBOR frames    |

### com.atproto.server (9/26 - 35%)

| Endpoint            | Status      | Notes                                               |
| ------------------- | ----------- | --------------------------------------------------- |
| `activateAccount`   | ✅ Complete | Transition deactivated → active                     |
| `createSession`     | ✅ Complete | JWT + static token auth                             |
| `deactivateAccount` | ✅ Complete | Transition active → deactivated                     |
| `deleteSession`     | ✅ Complete | Stateless (client-side)                             |
| `describeServer`    | ✅ Complete | Server capabilities                                 |
| `getAccountStatus`  | ✅ Complete | Returns activation state, repo metrics, blob counts |
| `getServiceAuth`    | ✅ Complete | Service JWTs for AppView/external services          |
| `getSession`        | ✅ Complete | Current session info                                |
| `refreshSession`    | ✅ Complete | Token refresh with validation                       |

### com.atproto.identity (2/6 - 33%)

| Endpoint        | Status      | Notes                                                 |
| --------------- | ----------- | ----------------------------------------------------- |
| `resolveHandle` | ⚠️ Partial  | Complete implementation (DNS + HTTPS for any handle)  |
| `updateHandle`  | ✅ Complete | Verifies handle, updates PLC for did:plc, emits event |

### app.bsky.\* (3 endpoints)

| Endpoint                | Status      | Notes                                          |
| ----------------------- | ----------- | ---------------------------------------------- |
| `actor.getPreferences`  | ✅ Complete | Persists to SQLite                             |
| `actor.putPreferences`  | ✅ Complete | Persists to SQLite                             |
| `ageassurance.getState` | ✅ Stub     | Returns "assured" (self-hosted = pre-verified) |

## TODO Endpoints (Grouped by Priority)

### Migration Progress Tracking ✅ Complete

All P1 migration endpoints have been implemented:

- ✅ `listMissingBlobs` - List blobs referenced but not uploaded
- ✅ Enhanced `getAccountStatus` - Full migration metrics
- ✅ `getBlocks` - Bulk block retrieval
- ✅ Blob tracking infrastructure (`record_blob`, `imported_blobs` tables)

### App Passwords (P2 - Important)

| Endpoint            | Purpose                                 |
| ------------------- | --------------------------------------- |
| `createAppPassword` | Create app-specific revocable passwords |
| `listAppPasswords`  | List all app passwords                  |
| `revokeAppPassword` | Revoke specific app password            |

**Total: 3 endpoints**

### Advanced Sync (P3 - Nice to Have)

| Endpoint           | Purpose                             |
| ------------------ | ----------------------------------- |
| `getLatestCommit`  | Get latest commit without full repo |
| `getRecord` (sync) | Get record with merkle proof        |

**Total: 2 endpoints**

## Not Implementing

### createAccount

**Reason:** Account creation happens at deploy time, not via API.

For migration: DID set in env vars, data imported via `importRepo`.
For new accounts: Deploy script generates DID, publishes to PLC.

May revisit if tools like Goat require it.

### PLC Operation Endpoints

| Endpoint                       | Reason                                |
| ------------------------------ | ------------------------------------- |
| `getRecommendedDidCredentials` | Not needed - keys generated at deploy |
| `requestPlcOperationSignature` | Handled by old PDS during migration   |
| `signPlcOperation`             | Handled by old PDS during migration   |
| `submitPlcOperation`           | Handled by old PDS during migration   |

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

### Phase 1: Account Lifecycle ✅ Complete

Enable deactivated account pattern for migration:

- ✅ `activateAccount`
- ✅ `deactivateAccount`
- ✅ Deactivation guards on write operations
- ✅ `INITIAL_ACTIVE` env var for deploy-time configuration

### Phase 2: Migration Progress Tracking ✅ Complete

Enable reliable migration with progress tracking:

- ✅ Add blob tracking infrastructure (`record_blob`, `imported_blobs` tables)
- ✅ Enhance `getAccountStatus` with full metrics
- ✅ Implement `listMissingBlobs` endpoint
- ✅ Implement `getBlocks` endpoint

### Phase 3: OAuth Provider ✅ Complete

Enable ecosystem compatibility with "Login with Bluesky" apps.
See `complete/oauth-provider.md` for implementation details.

### Phase 4: App Passwords (3 endpoints)

Multi-device auth with revocable app passwords.

### Phase 5: Advanced Sync (2 endpoints)

Efficient partial sync and merkle proofs.

## Endpoint Coverage by Namespace

| Namespace              | Supported | Total | Coverage         |
| ---------------------- | --------- | ----- | ---------------- |
| `com.atproto.repo`     | 10        | 11    | 91%              |
| `com.atproto.sync`     | 7         | 11    | 64%              |
| `com.atproto.server`   | 9         | 26    | 35%              |
| `com.atproto.identity` | 1         | 6     | 17%              |
| `com.atproto.admin`    | 0         | 14    | 0% (intentional) |
| `app.bsky.*`           | 3         | -     | Proxy model      |

## References

- [AT Protocol Specs](https://atproto.com/specs)
- [Official PDS Implementation](https://github.com/bluesky-social/atproto/tree/main/packages/pds)
- [Account Migration Guide](https://atproto.com/guides/account-migration)
