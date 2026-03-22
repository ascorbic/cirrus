# Add and Test Fname Registration in Agent FID Creation

**Status:** Complete
**Branch:** `cboscolo/agent-fname-registration`

## What Was Done

- Added `--fname <name>` flag to `scripts/test-agent-account.ts`
- Script signs EIP-712 UserNameProof with the test wallet's custody key
- Checks fname availability via `fnames.farcaster.xyz` before signing
- Includes `fname`, `fnameSig`, `fnameTimestamp` in the create request
- On testnet: confirms signing/plumbing works, skips registration verification
- On mainnet: verifies fname registered and handle set to `<name>.farcaster.social`

## Decisions

- **No server-side availability check endpoint** — clients query `fnames.farcaster.xyz/transfers/current?name=<name>` directly
- **Fname registration is mainnet-only** — `fnames.farcaster.xyz` validates FIDs against Optimism mainnet, so testnet FIDs are rejected. Full e2e verification deferred to production deployment.

## Existing Plumbing (no changes needed)

- `apps/signup/src/fname.ts` — `registerFname()` posts to fnames.farcaster.xyz
- `apps/signup/src/eip712.ts` — EIP-712 `FNAME_DOMAIN` and `FNAME_TYPES`
- `apps/signup/src/index.ts` — accepts optional fname fields, graceful degradation on failure
- Registration-params returns `fnameTypedData` template for client signing
