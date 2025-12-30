# OAuth Provider Implementation

**Status:** ✅ Complete
**Package:** `@ascorbic/atproto-oauth-provider`

## Overview

OAuth 2.1 provider with AT Protocol extensions enabling "Login with Bluesky" ecosystem compatibility. Implemented as a standalone package integrated with the PDS.

## What Was Built

### Package: `@ascorbic/atproto-oauth-provider`

A purpose-built OAuth 2.1 provider (not extending Cloudflare's OAuth provider) with:

#### Core OAuth 2.1
- **PKCE** (RFC 7636) - S256 challenge method only (per AT Protocol spec)
- **DPoP** (RFC 9449) - Demonstrating Proof of Possession for token binding
- **PAR** (RFC 9126) - Pushed Authorization Requests
- Token generation with configurable TTLs
- Refresh token rotation

#### AT Protocol Extensions
- **DID-based client discovery** - Resolves client metadata from `did:web` DIDs
- **URL-based client IDs** - Also supports HTTPS URLs as client IDs
- **Zod validation** - Uses `@atproto/oauth-types` for metadata validation
- **atproto scope** - Single scope for AT Protocol access

#### Security Features
- CSP headers on consent UI
- DPoP key binding (prevents token theft)
- Nonce replay prevention
- Short-lived auth codes (5 min)
- Access token TTL (60 min)
- Refresh token TTL (90 days)

### Package Structure

```
packages/oauth-provider/
├── src/
│   ├── index.ts           # Public exports
│   ├── provider.ts        # ATProtoOAuthProvider class
│   ├── storage.ts         # OAuthStorage interface + InMemoryOAuthStorage
│   ├── client-resolver.ts # DID/URL-based client discovery
│   ├── dpop.ts            # DPoP verification (RFC 9449)
│   ├── par.ts             # PAR handler (RFC 9126)
│   ├── pkce.ts            # PKCE verification (RFC 7636)
│   ├── tokens.ts          # Token generation/validation
│   ├── encoding.ts        # randomString utility
│   └── ui.ts              # Consent UI rendering
└── test/
    ├── helpers.ts         # Test utilities (DPoP proof generation)
    ├── dpop.test.ts       # 17 tests
    ├── oauth-flow.test.ts # 10 tests
    ├── par.test.ts        # 11 tests
    └── pkce.test.ts       # 11 tests
```

### PDS Integration

The oauth-provider package is integrated into the PDS:

```
packages/pds/src/
├── oauth.ts           # OAuth routes + DOProxyOAuthStorage
├── oauth-storage.ts   # SqliteOAuthStorage for DO SQLite
├── account-do.ts      # RPC methods for OAuth storage operations
└── middleware/auth.ts # DPoP token support in auth middleware
```

**Key Integration Patterns:**

1. **DOProxyOAuthStorage** - Delegates storage operations to DO RPC methods (avoids serialization issues with SQL connections)

2. **SqliteOAuthStorage** - SQLite-backed storage in Durable Objects with tables:
   - `oauth_auth_codes` - Authorization codes
   - `oauth_tokens` - Access/refresh tokens
   - `oauth_clients` - Cached client metadata
   - `oauth_par` - PAR requests
   - `oauth_nonces` - DPoP replay prevention

3. **Auth Middleware** - Extended to support both:
   - Bearer tokens (session JWTs)
   - DPoP tokens (OAuth access tokens)

## OAuth Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/oauth-authorization-server` | GET | Server metadata discovery |
| `/oauth/authorize` | GET | Authorization endpoint (shows consent UI) |
| `/oauth/authorize` | POST | Consent form submission |
| `/oauth/token` | POST | Token endpoint (code exchange, refresh) |
| `/oauth/revoke` | POST | Token revocation |
| `/oauth/par` | POST | Pushed Authorization Request |

## Dependencies

```json
{
  "dependencies": {
    "@atproto/crypto": "^0.4.5",
    "@atproto/oauth-types": "^0.5.2",
    "@atproto/syntax": "^0.4.2",
    "jose": "^6.1.3"
  }
}
```

## Test Coverage

- **oauth-provider package:** 49 tests
- **PDS OAuth integration:** 14 tests
- **Total:** 63 OAuth-related tests

## Usage

```typescript
import { ATProtoOAuthProvider } from "@ascorbic/atproto-oauth-provider";

const provider = new ATProtoOAuthProvider({
  issuer: "https://your-pds.com",
  storage: yourOAuthStorage,
  clientResolver: new ClientResolver({ storage: yourOAuthStorage }),
  authenticateUser: async (username, password) => {
    // Verify credentials, return DID or null
  },
});

// Mount routes
app.route("/", provider.routes());
```

## What's NOT Implemented (Out of Scope)

- Dynamic client registration endpoint (clients use DID-based discovery)
- Token introspection endpoint
- OIDC (OpenID Connect) claims
- Multiple scopes (AT Protocol uses single `atproto` scope)

## References

- [AT Protocol OAuth Spec](https://atproto.com/specs/oauth)
- [RFC 9449: DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 9126: PAR](https://www.rfc-editor.org/rfc/rfc9126.html)
- [RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
