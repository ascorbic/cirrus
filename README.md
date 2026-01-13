<div align="center">
    <h1>☁️</h1>
    <h1><samp>CIRRUS</samp></h1>
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

## Before You Get Started

Before running your PDS, you'll need:

1. **A Cloudflare account** – Sign up at [cloudflare.com](https://cloudflare.com) if you don't have one
2. **Your domain added to Cloudflare** – Add the domain you plan to use for your PDS to your Cloudflare account:
   - Log into the Cloudflare dashboard
   - Click "Add a site" and enter your domain
   - Follow the instructions to update your domain's nameservers to point to Cloudflare
   - Wait for DNS propagation (usually a few minutes, can take up to 24 hours)

Once your domain is active in Cloudflare, you can proceed with the setup wizard.

## Packages

| Package                                                   | Description                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@getcirrus/pds`](./packages/pds/)                       | The PDS implementation – handles repository operations, federation, OAuth, and the CLI |
| [`@getcirrus/oauth-provider`](./packages/oauth-provider/) | OAuth 2.1 provider for "Login with Bluesky"                                            |
| [`create-pds`](./packages/create-pds/)                    | Scaffolding CLI to create new PDS projects                                             |

## Status

⚠️ **This is experimental beta software under active development.** While the core features are functional and account migration has been tested, this PDS implementation is still being refined. Breaking changes may occur, and not all edge cases have been discovered. Consider backing up important data before migrating a primary account.

Core features currently working:

- Repository operations (create, read, update, delete records)
- Federation (sync, firehose, blob storage)
- OAuth 2.1 provider (PKCE, DPoP, PAR)
- Account migration from existing PDS (tested and verified)
- Account migration to another PDS (stateless token generation)
- Passkey authentication for passwordless login

See the [PDS documentation](./packages/pds/) for current limitations and roadmap.

## Key Safety

Your signing key controls your identity. Cloudflare secrets cannot be retrieved after they're set, so backing up your key during setup is critical.

### During Setup

When you run `pds init`, you'll be prompted to back up your signing key. Store it somewhere safe – a password manager, encrypted backup, or similar.

### Key Recovery

If you've cloned to a new machine and see the "Key Recovery Required" error:

1. **Restore from backup** – If you backed up your key (recommended), add it to `.dev.vars`:
   ```
   SIGNING_KEY=your-backed-up-key-here
   ```
2. **Run init again** – `pds init` will detect the local key and continue

### If You've Lost Your Key

**For did:web users:**
- Generate a new key by clearing `.dev.vars` and re-running `pds init`
- Old signatures become unverifiable – followers may see warnings
- Your identity continues, but there's no cryptographic proof of continuity

**For did:plc users:**
- If you have a recovery key registered with PLC, you can rotate to a new signing key
- Without a recovery key, you'll need to start a new identity
- See the [AT Protocol PLC documentation](https://github.com/did-method-plc/did-method-plc) for recovery operations

## Requirements

- Cloudflare account with R2 enabled
- A domain you control (for your handle and DID)

## Resources

- [AT Protocol Documentation](https://atproto.com)
- [Bluesky](https://bsky.app)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)

## License

MIT. © Matt Kane (@ascorbic)
