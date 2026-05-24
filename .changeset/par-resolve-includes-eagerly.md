---
"@getcirrus/oauth-provider": patch
---

PAR (`/oauth/par`) now resolves every `include:<nsid>` permission-set scope eagerly and rejects with `invalid_scope` when an include points at a nonexistent or non-permission-set lexicon. Previously the resolver only ran at the authorize step, so clients with a typo in an include scope got a fresh `request_uri` from PAR and only learned about the bad scope at consent time. Matches reference oauth-provider behaviour (`request-manager.ts:297-313`).
