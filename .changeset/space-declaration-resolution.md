---
"@getcirrus/oauth-provider": patch
---

Fix `space:` scope resolution in the consent UI. `@atcute/lexicon-resolver` validates fetched lexicon documents against `@atcute/lexicon-doc`, whose def-type whitelist has no `type: "space"`, so a correctly published space type declaration failed with `InvalidLexiconSchemaError` and the consent screen showed "could not resolve space type declaration" for every space scope. `resolveSpaceDeclaration` now replicates the resolver's authenticated steps itself — resolve the DID document, fetch the record proof CAR, and verify the commit signature — then validates `defs.main` against the local space shape, keeping full proof verification while tolerating the unknown def type. The workaround can be removed once upstream `@atcute/lexicon-doc` gains the `space` def type.
