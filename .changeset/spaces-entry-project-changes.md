---
"@getcirrus/pds": patch
"@getcirrus/oauth-provider": patch
---

The 0.19.0 release notes for atproto spaces now list what an existing project has to change: the R2 lifecycle rule for staged blob uploads, and the Durable Object bindings, migration, and worker exports needed to enable spaces. There is no code change in this release. It exists so that `upgrade-pds`, which reads each package's changelog at its release tag, shows those instructions.
