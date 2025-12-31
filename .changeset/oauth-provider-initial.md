---
"@ascorbic/atproto-oauth-provider": minor
---

Initial release of AT Protocol OAuth 2.1 Provider

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
