---
"create-pds": patch
---

Fix deploys of freshly scaffolded workers failing with "Cannot apply new-class migration to class 'SpaceDurableObject' that is not exported by script". The generated worker entry now exports the Space Durable Object classes that its wrangler config declares.
