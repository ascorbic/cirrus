# @getcirrus/oauth-provider

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
