# @getcirrus/oauth-provider

## 0.3.1

### Patch Changes

- [#114](https://github.com/ascorbic/cirrus/pull/114) [`982e067`](https://github.com/ascorbic/cirrus/commit/982e067aec5b7a3ec0f30bdf14146612fabca186) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix OAuth for localhost clients per AT Protocol spec

  Localhost clients (using `http://localhost` as client_id) are now accepted per the AT Protocol OAuth specification. This enables local development tools and CLI applications to authenticate without requiring a registered client.
  - Added `isLocalhostClientId()` helper to detect localhost client URIs
  - Updated `ClientResolver` to generate metadata for localhost clients dynamically
  - Localhost clients are treated as public clients with no client authentication
  - Redirect URIs must use `http://127.0.0.1` with any port (per spec requirement)

## 0.3.0

### Minor Changes

- [#88](https://github.com/ascorbic/cirrus/pull/88) [`356735e`](https://github.com/ascorbic/cirrus/commit/356735e92daff0354c8238728029c072a4b1952b) Thanks [@ascorbic](https://github.com/ascorbic)! - Add passkey (WebAuthn) support for passwordless authentication

  **PDS package:**
  - New CLI commands: `pds passkey add`, `pds passkey list`, `pds passkey remove`
  - QR code display in terminal for easy mobile registration
  - Passkey storage and management via Durable Object RPC

  **OAuth provider:**
  - Passkey login option on authorization page
  - Cross-device authentication support (scan QR code from phone)
  - Automatic passkey discovery for returning users

### Patch Changes

- [`7074a27`](https://github.com/ascorbic/cirrus/commit/7074a2707797c6e0d1aace48ab02ca783c43e85e) Thanks [@ascorbic](https://github.com/ascorbic)! - Require Pushed Authorization Requests (PAR) for OAuth authorization
  - Set `require_pushed_authorization_requests: true` in server metadata (per ATProto spec)
  - Reject direct authorization requests when PAR is enabled – clients must use `/oauth/par` first

  Fixes #80 (login with tangled.org)

## 0.2.1

### Patch Changes

- [#82](https://github.com/ascorbic/cirrus/pull/82) [`e5507d1`](https://github.com/ascorbic/cirrus/commit/e5507d1ced8ed70e2981b737978d97967e4e8cd8) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix support for confidential OAuth clients with remote JWKS (like leaflet.pub):
  - Accept issuer URL as valid JWT audience (not just token endpoint)
  - Invalidate stale cache entries missing tokenEndpointAuthMethod

## 0.2.0

### Minor Changes

- [#77](https://github.com/ascorbic/cirrus/pull/77) [`2ea70ce`](https://github.com/ascorbic/cirrus/commit/2ea70ceb8a52de50787d06e38e1ddb5b31a051d2) Thanks [@ascorbic](https://github.com/ascorbic)! - Add private_key_jwt client authentication and fix response_mode default
  - Implement RFC 7523 JWT Bearer client authentication for confidential OAuth clients
  - Add `private_key_jwt` to `token_endpoint_auth_methods_supported` in metadata
  - Support inline JWKS and remote JWKS URI for client public keys
  - Fix default `response_mode` from `fragment` to `query` for authorization code flow
  - Add `userinfo_endpoint` to OAuth server metadata

## 0.1.3

### Patch Changes

- [#63](https://github.com/ascorbic/cirrus/pull/63) [`95ffff6`](https://github.com/ascorbic/cirrus/commit/95ffff6766325822fe621ff82f1c3ab8850dcdea) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix CSP blocking OAuth authorization flow in Chrome

  Remove `form-action` from CSP due to inconsistent browser behavior with redirects. Chrome blocks redirects after form submission if the redirect URL isn't in `form-action`, while Firefox does not. Since OAuth requires redirecting to the client's callback URL after consent, `form-action` cannot be used without breaking the flow in Chrome.

- [#65](https://github.com/ascorbic/cirrus/pull/65) [`30910f7`](https://github.com/ascorbic/cirrus/commit/30910f71596b04947a0c157acd4bf6edb3a3d298) Thanks [@ascorbic](https://github.com/ascorbic)! - Switch to atcute for most internal protocol handling

## 0.1.2

### Patch Changes

- [#47](https://github.com/ascorbic/cirrus/pull/47) [`b4de6fa`](https://github.com/ascorbic/cirrus/commit/b4de6fa1117d37a6df4fa271404544f883757e07) Thanks [@ascorbic](https://github.com/ascorbic)! - Rename to Cirrus

## 0.1.1

### Patch Changes

- [#48](https://github.com/ascorbic/cirrus/pull/48) [`8362bae`](https://github.com/ascorbic/cirrus/commit/8362bae095b37cdf4a4d9c5232fe3ed55d201531) Thanks [@ascorbic](https://github.com/ascorbic)! - Deprecate packages in favor of @getcirrus/pds and @getcirrus/oauth-provider

  These packages have been renamed and will no longer receive updates under the @ascorbic scope. Please migrate to the new package names:
  - `@ascorbic/pds` → `@getcirrus/pds`
  - `@ascorbic/atproto-oauth-provider` → `@getcirrus/oauth-provider`

## 0.1.0

### Minor Changes

- [#33](https://github.com/ascorbic/atproto-worker/pull/33) [`4f5b50c`](https://github.com/ascorbic/atproto-worker/commit/4f5b50c4911514f0f87dc3f3856a2b4e2ccb9b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial release of AT Protocol OAuth 2.1 Provider

  A complete OAuth 2.1 Authorization Server implementation for AT Protocol, enabling "Login with Bluesky" functionality.

  **Features:**
  - Full OAuth 2.1 Authorization Code flow with PKCE
  - DPoP (Demonstrating Proof of Possession) support for token binding
  - PAR (Pushed Authorization Requests) for secure request initiation
  - Client metadata discovery and validation
  - Token rotation and revocation
  - SQLite-based storage adapter for Durable Objects

  **Security:**
  - Cryptographically secure token generation
  - PKCE challenge verification (SHA-256)
  - DPoP proof validation with replay protection
  - Token binding to prevent token theft

  **Compatibility:**
  - Integrates with `@atproto/oauth-client` for client applications
  - Storage interface allows custom backends beyond SQLite
  - Built for Cloudflare Workers with Durable Objects

  This package enables AT Protocol PDSs to act as OAuth providers, allowing users to authenticate with third-party applications using their PDS identity.
