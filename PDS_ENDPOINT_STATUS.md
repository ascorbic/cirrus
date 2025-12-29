# PDS Endpoint Implementation Status

This document tracks the implementation status of AT Protocol XRPC endpoints for this Personal Data Server (PDS). It compares our current implementation against the official lexicons from the [bluesky-social/atproto](https://github.com/bluesky-social/atproto) repository.

**Last Updated:** 2025-12-29
**Total Endpoints Implemented:** 26
**Test Coverage:** 112 tests passing

## Legend
- ✅ **Implemented** - Fully functional with tests
- 🚧 **Partial** - Basic implementation, may need enhancements
- ❌ **Not Implemented** - Required for full PDS compliance
- ⚪ **Optional** - Not required for basic PDS functionality

---

## com.atproto.repo (Repository Operations)

Core endpoints for managing user repositories and records.

| Endpoint | Status | Notes |
|----------|--------|-------|
| `createRecord` | ✅ | Full lexicon validation, TID generation |
| `putRecord` | ✅ | Update/create with explicit rkey |
| `deleteRecord` | ✅ | Record deletion with firehose events |
| `getRecord` | ✅ | Fetch individual records |
| `listRecords` | ✅ | Collection enumeration with pagination |
| `uploadBlob` | ✅ | Image/blob upload with size limits |
| `applyWrites` | ✅ | Batch operations (create/update/delete) |
| `importRepo` | ✅ | CAR file import for account migration |
| `describeRepo` | ✅ | Repository metadata |
| `listMissingBlobs` | ❌ | Used for blob sync/recovery |

**Implementation Details:**
- All mutations include lexicon validation using official Bluesky schemas
- CAR import uses `readCarWithRoot()` from `@atproto/repo` package
- DID validation prevents incorrect migrations
- Blob storage integrated with R2

---

## com.atproto.sync (Federation & Sync)

Endpoints for repository synchronization and federation between PDS instances.

| Endpoint | Status | Notes |
|----------|--------|-------|
| `getRepo` | ✅ | Export repository as CAR file |
| `getBlob` | ✅ | Fetch blob by CID |
| `listBlobs` | ✅ | Enumerate all blobs in repo |
| `getRepoStatus` | ✅ | Repository status (DID, head, rev) |
| `listRepos` | ✅ | List all repositories (single-user PDS) |
| `subscribeRepos` | ✅ | WebSocket firehose for commit events |
| `getRecord` | ❌ | Fetch single record from commit history |
| `getBlocks` | ❌ | Fetch repo blocks by CID |
| `getCheckout` | ❌ | Full repo checkout at revision |
| `getHead` | ❌ | Get current repo head |
| `getLatestCommit` | ❌ | Get latest commit for repo |
| `listReposByCollection` | ❌ | Filter repos by collection type |
| `notifyOfUpdate` | ❌ | Notify other PDS of updates |
| `requestCrawl` | ❌ | Request relay to crawl repo |
| `getHostStatus` | ❌ | Federated PDS status check |
| `listHosts` | ❌ | Multi-tenant PDS feature |

**Implementation Details:**
- CAR export uses `blocksToCarFile()` from `@atproto/repo`
- WebSocket firehose uses Durable Object hibernation API
- CBOR frame encoding for commit events
- Cursor-based event replay from SQLite

---

## com.atproto.server (Account & Session Management)

Endpoints for account lifecycle and authentication.

| Endpoint | Status | Notes |
|----------|--------|-------|
| `describeServer` | ✅ | Server metadata and capabilities |
| `createSession` | ✅ | JWT-based authentication |
| `refreshSession` | ✅ | Token refresh with rotation |
| `getSession` | ✅ | Current session info |
| `deleteSession` | ✅ | Session termination |
| `checkAccountStatus` | ✅ | Account migration status check |
| `createAccount` | ❌ | Account registration |
| `activateAccount` | ❌ | Account activation flow |
| `deactivateAccount` | ❌ | Temporary account suspension |
| `deleteAccount` | ❌ | Permanent account deletion |
| `requestAccountDelete` | ❌ | Account deletion request |
| `createAppPassword` | ❌ | App-specific passwords |
| `listAppPasswords` | ❌ | Enumerate app passwords |
| `revokeAppPassword` | ❌ | Revoke app password |
| `confirmEmail` | ❌ | Email verification |
| `requestEmailConfirmation` | ❌ | Resend verification email |
| `updateEmail` | ❌ | Change account email |
| `requestEmailUpdate` | ❌ | Request email change |
| `requestPasswordReset` | ❌ | Password reset flow |
| `resetPassword` | ❌ | Complete password reset |
| `getAccountInviteCodes` | ❌ | List invite codes |
| `createInviteCode` | ❌ | Generate single invite |
| `createInviteCodes` | ❌ | Bulk invite generation |
| `getServiceAuth` | ❌ | Service-to-service auth |
| `reserveSigningKey` | ❌ | Key rotation preparation |

**Implementation Details:**
- JWT sessions with access + refresh tokens (15min + 7 days)
- Bearer token authentication for single-user PDS
- bcrypt password hashing
- Account migration status returns proper schema with repoCommit

---

## app.bsky.* (Bluesky App Endpoints)

Optional Bluesky-specific endpoints. Most app logic handled by AppView.

| Endpoint | Status | Notes |
|----------|--------|-------|
| `app.bsky.actor.getPreferences` | 🚧 | Returns empty preferences |
| `app.bsky.actor.putPreferences` | 🚧 | Stub implementation |
| `app.bsky.ageassurance.getState` | 🚧 | Returns compliant state |

**Note:** Full Bluesky app functionality (feeds, notifications, etc.) is typically provided by separate AppView services. This PDS focuses on repository and identity management.

---

## Identity Resolution

| Endpoint | Status | Notes |
|----------|--------|-------|
| `com.atproto.identity.resolveHandle` | ✅ | Handle to DID resolution |
| DID document serving | ✅ | `/.well-known/did.json` |
| Handle verification | ✅ | DNS TXT record support |

---

## Additional Features

### Account Migration
- ✅ `importRepo` - Import repository from CAR file
- ✅ `checkAccountStatus` - Migration status checking
- ✅ CAR file validation and DID verification
- ✅ Prevents import over existing repository
- ✅ 100MB size limit enforcement

### Blob Storage
- ✅ R2 integration for blob persistence
- ✅ Image upload with mimetype validation
- ✅ CID-based addressing
- ✅ Blob enumeration and retrieval

### Real-time Federation
- ✅ WebSocket-based firehose (`subscribeRepos`)
- ✅ Sequential commit event log
- ✅ CBOR frame encoding
- ✅ Cursor-based replay

### Validation
- ✅ Lexicon schema validation for all mutations
- ✅ Official Bluesky schemas loaded from `@atproto/lexicon`
- ✅ Optimistic validation for unknown schemas

---

## Testing Summary

**Total Tests:** 112 passing

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| Storage | 16 | Block storage, repo initialization |
| XRPC | 32 | All implemented endpoints |
| Firehose | 8 | WebSocket subscriptions |
| Blobs | 10 | Upload, retrieval, R2 integration |
| Sessions | 15 | Auth flows, JWT validation |
| Validation | 8 | Lexicon enforcement |
| Bluesky Validation | 11 | Official schema compliance |
| Migration | 9 | CAR import/export workflows |
| Service Auth | 3 | Inter-service authentication |

---

## Priority Roadmap

### High Priority (Core PDS Functionality)
1. **Account Creation** - `com.atproto.server.createAccount`
2. **Account Deletion** - `com.atproto.server.deleteAccount`
3. **Missing Blob Sync** - `com.atproto.repo.listMissingBlobs`
4. **Block Retrieval** - `com.atproto.sync.getBlocks` (for efficient sync)

### Medium Priority (Enhanced Federation)
1. **Commit History** - `com.atproto.sync.getLatestCommit`, `getHead`
2. **Crawl Requests** - `com.atproto.sync.requestCrawl` (relay integration)
3. **Update Notifications** - `com.atproto.sync.notifyOfUpdate`

### Low Priority (Optional Features)
1. **App Passwords** - Alternative auth method
2. **Email Verification** - Account security
3. **Invite Codes** - Growth management
4. **Service Auth** - Cross-service authorization

### Not Required (Multi-tenant Features)
- `com.atproto.sync.listHosts` - Only for multi-tenant PDS
- `com.atproto.sync.getHostStatus` - Only for multi-tenant PDS

---

## References

- **AT Protocol Spec:** https://atproto.com/specs/atp
- **XRPC Spec:** https://atproto.com/specs/xrpc
- **Lexicon Spec:** https://atproto.com/specs/lexicon
- **Official Lexicons:** https://github.com/bluesky-social/atproto/tree/main/lexicons
- **@atproto packages:** https://www.npmjs.com/search?q=%40atproto

---

## Architecture Notes

This PDS implementation uses:
- **Cloudflare Workers** - Stateless request routing
- **Durable Objects** - Stateful repository storage (SQLite)
- **R2** - Blob storage
- **WebSocket Hibernation API** - Efficient firehose subscriptions

Key design decisions:
- Single-user PDS (one account per deployment)
- Bearer token authentication (simple AUTH_TOKEN env var)
- Official `@atproto/*` packages for all protocol operations
- Lexicon validation on all mutations
- SQLite-based event log for firehose
