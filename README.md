<div align="center">
    <h1>f.i</h1>
    <h1><samp>fid.is</samp></h1>
		<p><em>Your Farcaster identity on Bluesky</em></p>
</div>

An [AT Protocol](https://atproto.com) Personal Data Server (PDS) that gives every Farcaster user an identity and PDS on Cloudflare Workers.

For FID `NNN`:
- **DID**: `did:web:NNN.fid.is`
- **Handle**: `NNN.fid.is`
- **PDS**: `https://NNN.fid.is`

## Architecture

This implementation uses Cloudflare Workers with Durable Objects, R2, and D1:

- **Worker** – Stateless edge handler for routing, authentication, and DID document serving
- **Durable Object** – Per-account SQLite storage for AT Protocol repositories
- **R2** – Object storage for blobs (images, videos)
- **D1** – FID-to-DID registry for multi-tenant routing

## Packages

| Package                                                | Description                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [`@fidis/pds`](./packages/pds/)                        | The PDS implementation – handles repository operations, federation, OAuth, and the CLI |
| [`@fidis/oauth-provider`](./packages/oauth-provider/)  | OAuth 2.1 provider for "Login with Bluesky"                                            |
| [`@fidis/fid-pds`](./apps/fid-pds/)                   | Production deployment wrapper for fid.is                                               |
| [`@fidis/miniapp`](./apps/miniapp/)                    | Account management UI (Farcaster mini app)                                             |
| [`@fidis/signup`](./apps/signup/)                      | Signup service for new FID creation                                                    |
| [`@fidis/sync`](./apps/sync/)                          | Farcaster signer key management service                                                |

## Status

Core features currently working:

- Repository operations (create, read, update, delete records)
- Federation (sync, firehose, blob storage)
- OAuth 2.1 provider (PKCE, DPoP, PAR)
- Farcaster Quick Auth and SIWF account creation
- Account lifecycle (activate, deactivate, delete, re-create)
- Passkey authentication for passwordless login
- Agent account creation via x402 payment

See the [PDS documentation](./packages/pds/) for details.

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Farcaster](https://farcaster.xyz)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)

## License

MIT
