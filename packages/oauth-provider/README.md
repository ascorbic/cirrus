# @getcirrus/oauth-provider

> **🚨 This package has been renamed to `@getcirrus/oauth-provider`**
>
> This package is deprecated and will no longer receive updates. Please migrate to [`@getcirrus/oauth-provider`](https://www.npmjs.com/package/@getcirrus/oauth-provider) for the latest features and bug fixes.

AT Protocol OAuth 2.1 Authorization Server for Cloudflare Workers.

A complete OAuth 2.1 provider implementation that enables "Login with Bluesky" functionality for your PDS. Built specifically for Cloudflare Workers with Durable Objects.

## Features

- **OAuth 2.1 Authorization Code Flow** with PKCE (Proof Key for Code Exchange)
- **DPoP (Demonstrating Proof of Possession)** for token binding and enhanced security
- **PAR (Pushed Authorization Requests)** for secure authorization request initiation
- **Client Metadata Discovery** via `client_id` URL resolution
- **Token Management** - generation, rotation, and revocation
- **Storage Interface** - pluggable storage backend (SQLite adapter included)

## Installation

```bash
npm install @getcirrus/oauth-provider
# or
pnpm add @getcirrus/oauth-provider
```

## Quick Start

```typescript
import { OAuthProvider } from "@getcirrus/oauth-provider";
import { OAuthStorage } from "./your-storage-implementation";

// Initialize the provider
const provider = new OAuthProvider({
  issuer: "https://your-pds.example.com",
  storage: new OAuthStorage(),
});

// Handle OAuth endpoints in your Worker
app.post("/oauth/par", async (c) => {
  const result = await provider.handlePAR(await c.req.formData());
  return c.json(result);
});

app.get("/oauth/authorize", async (c) => {
  const result = await provider.handleAuthorize(c.req.url);
  // Show authorization UI to user
  return c.html(renderAuthUI(result));
});

app.post("/oauth/token", async (c) => {
  const result = await provider.handleToken(
    await c.req.formData(),
    c.req.header("DPoP"),
  );
  return c.json(result);
});
```

## Architecture

### Provider

The `OAuthProvider` class is the main entry point. It handles:

- Client metadata validation and discovery
- Authorization request processing (with PAR support)
- Token generation and validation
- DPoP proof verification
- PKCE challenge verification

### Storage Interface

The provider uses a storage interface that you implement for your backend:

```typescript
export interface OAuthProviderStorage {
  // Authorization codes
  saveAuthCode(code: string, data: AuthCodeData): Promise<void>;
  getAuthCode(code: string): Promise<AuthCodeData | null>;
  deleteAuthCode(code: string): Promise<void>;

  // Access/refresh tokens
  saveTokens(data: TokenData): Promise<void>;
  getTokenByAccess(accessToken: string): Promise<TokenData | null>;
  getTokenByRefresh(refreshToken: string): Promise<TokenData | null>;
  revokeToken(accessToken: string): Promise<void>;
  revokeAllTokens(sub: string): Promise<void>;

  // Client metadata cache
  saveClient(clientId: string, metadata: ClientMetadata): Promise<void>;
  getClient(clientId: string): Promise<ClientMetadata | null>;

  // PAR (Pushed Authorization Requests)
  savePAR(requestUri: string, data: PARData): Promise<void>;
  getPAR(requestUri: string): Promise<PARData | null>;
  deletePAR(requestUri: string): Promise<void>;

  // DPoP nonce tracking
  checkAndSaveNonce(nonce: string): Promise<boolean>;
}
```

A SQLite implementation for Durable Objects is included in the `@getcirrus/pds` package.

## OAuth 2.1 Flow

### 1. Pushed Authorization Request (PAR)

Client initiates the flow by pushing authorization parameters to the server:

```http
POST /oauth/par
Content-Type: application/x-www-form-urlencoded

client_id=https://client.example.com/client-metadata.json
&code_challenge=XXXXXX
&code_challenge_method=S256
&redirect_uri=https://client.example.com/callback
&scope=atproto
&state=random-state
```

Response:

```json
{
  "request_uri": "urn:ietf:params:oauth:request_uri:XXXXXX",
  "expires_in": 90
}
```

### 2. Authorization

User is redirected to authorize the client:

```http
GET /oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:XXXXXX
```

After user approves, they're redirected back with an authorization code:

```http
HTTP/1.1 302 Found
Location: https://client.example.com/callback?code=XXXXXX&state=random-state
```

### 3. Token Exchange

Client exchanges the authorization code for tokens:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
DPoP: <dpop-proof-jwt>

grant_type=authorization_code
&code=XXXXXX
&redirect_uri=https://client.example.com/callback
&code_verifier=YYYYYY
&client_id=https://client.example.com/client-metadata.json
```

Response:

```json
{
  "access_token": "XXXXXX",
  "token_type": "DPoP",
  "expires_in": 3600,
  "refresh_token": "YYYYYY",
  "scope": "atproto",
  "sub": "did:plc:abc123"
}
```

## Security Features

### PKCE (Proof Key for Code Exchange)

All authorization flows require PKCE to prevent authorization code interception attacks:

- Client generates `code_verifier` (random string)
- Client sends SHA-256 hash as `code_challenge`
- Server verifies `code_verifier` matches during token exchange

### DPoP (Demonstrating Proof of Possession)

Binds tokens to specific clients using cryptographic proofs:

- Client generates a key pair
- Client includes DPoP proof JWT with each token request
- Tokens are bound to the client's public key
- Prevents token theft and replay attacks

### Replay Protection

- DPoP nonces are tracked to prevent replay attacks
- Authorization codes are single-use
- Refresh tokens can be rotated on each use

## Client Metadata Discovery

Clients are identified by a URL pointing to their metadata document:

```json
{
  "client_id": "https://client.example.com/client-metadata.json",
  "client_name": "Example App",
  "redirect_uris": ["https://client.example.com/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "atproto",
  "token_endpoint_auth_method": "none",
  "application_type": "web"
}
```

The provider automatically fetches and validates client metadata from the `client_id` URL.

## Integration with @atproto/oauth-client

This provider is designed to work seamlessly with `@atproto/oauth-client`:

```typescript
// Client side
import { OAuthClient } from "@atproto/oauth-client";

const client = new OAuthClient({
  clientMetadata: {
    client_id: "https://my-app.example.com/client-metadata.json",
    redirect_uris: ["https://my-app.example.com/callback"],
  },
});

// Initiate login
const authUrl = await client.authorize("https://user-pds.example.com", {
  scope: "atproto",
});

// Handle callback
const { session } = await client.callback(callbackParams);
```

## Error Handling

The provider returns standard OAuth 2.1 error responses:

```json
{
  "error": "invalid_request",
  "error_description": "Missing required parameter: code_challenge"
}
```

Common error codes:

- `invalid_request` - Malformed request
- `invalid_client` - Client authentication failed
- `invalid_grant` - Invalid authorization code or refresh token
- `unauthorized_client` - Client not authorized for this grant type
- `unsupported_grant_type` - Grant type not supported
- `invalid_scope` - Requested scope is invalid

## Testing

```bash
pnpm test
```

The package includes comprehensive tests for:

- Complete OAuth flows (PAR → authorize → token → refresh)
- PKCE verification
- DPoP proof validation
- Client metadata discovery
- Token rotation and revocation

## License

MIT

## Related Packages

- `@getcirrus/pds` - AT Protocol PDS implementation using this OAuth provider
- `@atproto/oauth-client` - Official AT Protocol OAuth client
- `@atproto/oauth-types` - TypeScript types for AT Protocol OAuth
