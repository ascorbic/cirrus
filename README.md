# @ascorbic/pds

A single-user [AT Protocol](https://atproto.com) Personal Data Server (PDS) that runs on Cloudflare Workers. Host your own Bluesky identity with minimal infrastructure.

> **⚠️ Experimental Software**
>
> This is an early-stage project under active development. **You cannot migrate your main Bluesky account to this PDS yet.** Use a test account or create a new identity for experimentation. Data loss, breaking changes, and missing features are expected.

## What is this?

A PDS is where your Bluesky data lives – your posts, follows, profile, and media. This package lets you run your own PDS on Cloudflare Workers, giving you control over your data and identity.

## Quick Start

The fastest way to get started:

```bash
npm create pds
```

## Packages

- [`@ascorbic/pds`](./packages/pds/) - The main PDS library
- [`create-pds`](./packages/create-pds/) - A CLI tool to scaffold a new PDS project
