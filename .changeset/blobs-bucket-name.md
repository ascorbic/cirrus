---
"create-pds": minor
---

The `create-pds` CLI now accepts a `--blobs-bucket-name` flag to set the R2 bucket name for blob storage. In interactive mode, users are prompted for a bucket name with `pds-blobs` as the default. The value is substituted into the generated `wrangler.jsonc` so the scaffolded project is ready to use without manual edits.
