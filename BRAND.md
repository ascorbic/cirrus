# fid.is Brand Guidelines

## Brand Name

**fid.is** — lowercase, as it appears in a URL bar. The domain is the brand.

- Written as: `fid.is` (always lowercase, with the dot)
- Pronounced: "fid dot is" or "fid-is"
- Never: "FidIs", "Fid.Is", "FIDIS", "WebFID"

The name carries a double meaning: every Farcaster ID (FID) *is* an identity — your FID is your key to the AT Protocol network.

The underlying PDS framework is part of the fid.is project. There is no separate framework brand.

## Messaging Hierarchy

### Level 1 — The One-Liner
> Your Farcaster identity on Bluesky.

Use in: app store listing, miniapp subtitle, social bios, link previews.

### Level 2 — The Elevator Pitch
> One account. Two networks.
>
> Use your Farcaster identity to post on Bluesky. No new account, no new password — just your FID.

Use in: landing page hero, introductory screens.

### Level 3 — The How-It-Works
> fid.is gives your Farcaster account a home on the AT Protocol — the open network behind Bluesky. Sign in with Farcaster, and you're live. Your identity, your data, your server.

Use in: below-the-fold explainer, about pages, onboarding flows.

### Level 4 — The Technical
> Every Farcaster ID gets a `did:web` identity and a personal data server at `NNN.fid.is`. Your PDS federates with the Bluesky network. You own your repo, your keys, and your data.

Use in: documentation, developer-facing materials, README.

## Voice and Tone

| Do | Don't |
|---|---|
| "Your Farcaster identity on Bluesky" | "Cross-protocol decentralized identity bridge" |
| "Sign in with Farcaster" | "Authenticate via SIWF" |
| "Your handle: @1898.fid.is" | "Your did:web:1898.fid.is DID document" |
| "You own your data" | "Self-sovereign personal data server" |
| "Takes 10 seconds" | "Seamless onboarding experience" |

**Tone:** Confident, concise, technical-but-not-jargony. Think Linear or Vercel — building for developers, writing like humans.

## Handling "More to Come"

Frame the current state as complete, hint at expansion without promising timelines:

- **Don't say:** "Coming soon: cross-posting" (makes the product feel incomplete)
- **Do say:** "Post on Bluesky today. More networks coming." (present tense first)
- Use **"starting with Bluesky"** — implies a series without committing to a schedule

## Key Terms

| Term | Usage |
|---|---|
| passkey | Common noun, lowercase. Not "PassKey" or "Passkey" (except at sentence start). |
| Farcaster | Always capitalized. A proper noun. |
| Bluesky | Always capitalized. A proper noun. |
| AT Protocol | Always "AT Protocol" on first use. "atproto" is acceptable in technical contexts. |
| FID | All caps. Short for Farcaster ID. |
| handle | Lowercase. The user's `@name` on the network. |
| PDS | All caps. Personal Data Server. Spell out on first use in user-facing copy, never in UI. |

## Color Palette

### Primary

| Name | Hex | Usage |
|---|---|---|
| Background | `#0a0a0a` | App background, splash screen |
| Foreground | `#fafafa` | Primary text |
| Muted | `#a1a1aa` | Secondary text, descriptions |
| Accent | `#3b82f6` | Primary actions, links |
| Border | `#27272a` | Dividers, input borders |

### Semantic

| Name | Hex | Usage |
|---|---|---|
| Success | `#22c55e` | Confirmations, completed states |
| Error | `#ef4444` | Errors, destructive actions |

### Logo Colors

The logo mark uses a gradient from `#7c6aef` (purple, Farcaster-adjacent) to `#38bdf8` (sky blue, Bluesky-adjacent), representing the bridge between the two networks. On dark backgrounds, use the gradient version. On constrained contexts (favicon), use the solid sky blue `#38bdf8`.

## Logo

The logo is the letters **f.i** set in a clean sans-serif weight, representing the beginning of "fid.is". The dot serves double duty as the domain separator and as a visual bridge element.

### Files

| File | Usage |
|---|---|
| `logo.svg` | Full logo mark, scalable |
| `icon-512.png` | App icon, miniapp icon (512x512) |
| `icon-192.png` | PWA icon (192x192) |
| `favicon.svg` | Browser tab favicon |
| `favicon.ico` | Legacy browser favicon |
| `og-image.svg` | Social/link preview card |
| `splash.svg` | Miniapp splash screen |

All assets are in `apps/miniapp/public/`.

## Typography

System font stack — no custom fonts to load:
```
-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

Monospace for handles, DIDs, and code:
```
"SF Mono", "Fira Code", "Fira Mono", Menlo, monospace
```
