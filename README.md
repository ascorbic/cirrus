<div align="center">
  <h1>☁️ Cirrus</h1>
  <p><em>The lightest PDS in the Atmosphere</em></p>
</div>

A single-user [AT Protocol](https://atproto.com) Personal Data Server (PDS) that runs on a Cloudflare Worker.

## Why run your own PDS?

A PDS is where Bluesky data lives – posts, follows, profile, and media. Running a personal PDS provides:

- **Independence from platform changes** – If Bluesky's ownership or policies change, the account remains under full control. No billionaire can take it away.
- **Network resilience** – A diverse ecosystem of PDS providers makes the AT Protocol network stronger. More independent servers mean no single point of failure.
- **Data sovereignty** – The repository lives on infrastructure under direct control
- **Portability** – Move between hosting providers without losing followers or identity

## Architecture

This implementation uses Cloudflare Workers with Durable Objects and R2:

- **Worker** – Stateless edge handler for routing, authentication, and DID document serving
- **Durable Object** – Single-instance SQLite storage for your AT Protocol repository
- **R2** – Object storage for blobs (images, videos)

The result is a PDS that runs at the edge with no servers to manage, automatic scaling, and pay-per-use pricing.

## Quick Start

```bash
npm create pds
```

This scaffolds a new project, installs dependencies, and runs the setup wizard. See the [PDS package documentation](./packages/pds/) for detailed setup and configuration.

## Packages

| Package                                                   | Description                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@getcirrus/pds`](./packages/pds/)                       | The PDS implementation – handles repository operations, federation, OAuth, and the CLI |
| [`@getcirrus/oauth-provider`](./packages/oauth-provider/) | OAuth 2.1 provider for "Login with Bluesky"                                            |
| [`create-pds`](./packages/create-pds/)                    | Scaffolding CLI to create new PDS projects                                             |

## Status

This is beta software under active development. Core functionality is complete and tested:

- ✅ Repository operations (create, read, update, delete records)
- ✅ Federation (sync, firehose, blob storage)
- ✅ OAuth 2.1 provider (PKCE, DPoP, PAR)
- ✅ Account migration from existing PDS
- ✅ 140+ tests passing

See the [PDS documentation](./packages/pds/) for current limitations and roadmap.

## Requirements

- Cloudflare account with Workers, Durable Objects, and R2 enabled
- A domain you control (for your handle and DID)
- Node.js 18+ for local development

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)

## License

MIT
