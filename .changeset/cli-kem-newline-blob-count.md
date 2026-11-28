---
"@getcirrus/pds": patch
---

Fix `pds` CLI bugs:

- `pds spaces kem` no longer treats a key in `.dev.vars` as the production key. After `pds spaces kem --local`, running it for production asked whether to replace a key that production did not have, and `pds spaces kem --publish` could publish the local key. Without `--local` the command now looks only at `wrangler.jsonc`; with `--local` it looks only at `.dev.vars`.
- Commands that write to `wrangler.jsonc`, such as `pds spaces kem` and `pds init`, no longer strip the file's trailing newline.
- `pds status` no longer prints lines like "815/294 blobs imported". The first number counted every blob ever uploaded, and the second only the blobs your migrated records referenced. It now checks the migrated blobs themselves and reports "All 294 migrated blobs imported" or "3 of 294 migrated blobs missing", with the total number of stored blobs on its own line.
- `pds migrate` and `pds activate` use the same check. Both used to compare the two counts, so on a PDS that had taken uploads since the import, `pds migrate` could report "Everything looks good!" and skip the transfer, and `pds activate` could pass its repo check, while migrated blobs were still missing. `pds migrate` now shows its resume progress and "images remaining" from the blobs that are missing, and `pds activate` reports "3 of 294 migrated blobs missing".
