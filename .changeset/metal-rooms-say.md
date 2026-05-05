---
"@getcirrus/pds": patch
---

fix(pds): Remove empty collections from cache on record delete.

When all records of a collection are deleted, it is now ensured that the collection is deleted from the user repository so collections don't linger around forever
