---
title: Deploy checklist
description: The path from a working local dev setup to a production deploy.
---

This checklist covers the steps between "the wizard ran successfully on the laptop" and "the PDS is live for the world to use."

Each item is a yes/no check. Most of them only need to be done once.

## Before the first production deploy

- [ ] **Domain is active in Cloudflare.** The PDS hostname's domain must show **Active** in the Cloudflare dashboard. DNS propagation can take a few minutes.
- [ ] **R2 is enabled on the Cloudflare account.** Required for blob storage. Enable from the R2 section of the dashboard.
- [ ] **`wrangler` is authenticated.** Run `pnpm wrangler whoami` to confirm. If not, run `pnpm wrangler login`.
- [ ] **Signing key is backed up.** See [Back up your signing key](/guides/back-up-signing-key/). After this step, the key cannot be retrieved from Cloudflare.
- [ ] **`DATA_LOCATION` is set deliberately.** This is hard to change later. See [Data placement](/concepts/data-placement/).
- [ ] **`PDS_HOSTNAME` matches the public DNS record.** The hostname in `wrangler.jsonc` must be reachable at that DNS name. Cloudflare Workers handles the routing via a custom domain or a worker route.

## The first production deploy

Push the secrets stored in `.dev.vars` to Cloudflare as Worker secrets:

```bash
pnpm pds init --production
```

This writes `AUTH_TOKEN`, `SIGNING_KEY`, `JWT_SECRET`, and `PASSWORD_HASH` as encrypted secrets on the Worker. These cannot be read back.

Deploy:

```bash
pnpm run deploy
```

`wrangler deploy` uploads the Worker, creates the `ACCOUNT` Durable Object namespace, and creates the R2 bucket on first run.

## After the first deploy

- [ ] **Verify the PDS responds.** `curl https://pds.example.com/xrpc/com.atproto.server.describeServer` should return JSON.
- [ ] **Verify the DID document is served.** `curl https://<did-host>/.well-known/did.json` (for `did:web`) or `curl https://plc.directory/<did>` (for `did:plc`) should list the Cirrus hostname and the correct public key.
- [ ] **Verify handle resolution.** `pds status` reports a green check on **Handle resolves**.
- [ ] **Sign in from the Bluesky app.** Use the account password set during `pds init`. See [Sign in to Bluesky](/guides/sign-in-to-bluesky/).
- [ ] **Confirm the firehose works.** Subscribe with `npx @atcute/cli sync subscribe-repos --pds https://pds.example.com`, then create a post and watch for an event.

## Recommended for production

- [ ] **Set up a passkey** for OAuth sign-ins. See [Set up passkey login](/guides/passkey-login/).
- [ ] **Create an app password** for any third-party client that signs in. See [Create an app password](/guides/app-password/).
- [ ] **Enable Cloudflare observability** for the Worker. The dashboard's **Workers & Pages → Analytics & Logs** section provides request counts, CPU time, and errors.
- [ ] **Subscribe to the GitHub releases** for `@getcirrus/pds` to know when to update.

## Optional

- [ ] **Custom hostname on the Worker.** If using a hostname other than `*.workers.dev`, add it as a custom domain in the Cloudflare dashboard. Cloudflare provisions the TLS certificate automatically.
- [ ] **Cloudflare Access** in front of admin paths if running on a shared deploy. Cirrus does not need this for the public XRPC surface but it can lock down `/oauth/authorize` etc. if desired.

## A note on emergencies

The single non-recoverable piece of state is the signing key. Everything else can be reconstructed from a CAR export and a fresh deploy. Export periodically:

```bash
curl "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=<did>" > backup.car
```

Keep the CAR file alongside the signing key in the same backup location.
