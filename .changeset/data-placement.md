---
"@getcirrus/pds": minor
---

Add data placement support for Durable Objects

- Added `DATA_LOCATION` environment variable for controlling DO placement
- Supports `eu` jurisdiction (hard guarantee) and location hints (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`)
- Default is `auto` (no location constraint, recommended for most users)
- Exported `DataLocation` type from package

These features use Cloudflare's Durable Object data location capabilities. The `eu` jurisdiction provides compliance guarantees that data never leaves the EU, while hints are best-effort suggestions for latency optimization.

Warning: Do not change this setting after initial deployment. It only affects newly-created DOs and will not migrate existing data.
