---
"@getcirrus/pds": patch
---

Return canonical AT Protocol blob objects from `com.atproto.repo.listRecords`. Repository iteration decodes blobs as compatibility `BlobRef` instances; these are now serialized through their JSON representation instead of leaking the internal `original` field and omitting the outer `$type: "blob"`.
