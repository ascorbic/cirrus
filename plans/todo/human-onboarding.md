# Human Onboarding — Privy + Web Frontend

## Context

Extracted from `fid-creation-signup.md`. The agent signup path (x402) is complete.
This covers letting non-Farcaster humans create a fid.is account.

## Requirements

- React frontend with Privy SDK for auth (SMS + Sign in with Farcaster)
- Signup flow UI: auth → FID creation → fname selection → account creation
- Could be a separate app or added to `apps/signup/` as static assets
- Deploy to `signup.fid.is`

## Open Questions

- Rate limiting: x402 payment gates agents. What gates the human path beyond
  Privy auth? Per-IP, per-phone-number limits?
