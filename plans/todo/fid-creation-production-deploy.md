# FID Creation — Production Deployment

## Context

Extracted from `fid-creation-signup.md`. The signup service works on testnet.
This covers moving to OP Mainnet.

## Requirements

- Deploy signup service to Cloudflare Workers
- Configure production env vars (OP Mainnet contracts, Privy prod credentials)
- Fund Privy server wallet with OP ETH for gas + storage rent
- Set `ACCOUNT_CREATION_KEY` on both signup service and PDS

## Open Questions

- x402 pricing: Current price (0.01 USDC) only covers account creation overhead.
  Should it also cover the ~$0.30 FID storage rent + gas that Privy pays? Or keep
  the x402 price low and absorb registration costs?
- FID confirmation latency: Optimism block time is ~2s. We create the PDS account
  immediately after tx inclusion (optimistic). Reorgs on OP are extremely rare but
  technically possible.
