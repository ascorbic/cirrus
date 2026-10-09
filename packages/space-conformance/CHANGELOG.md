# @getcirrus/space-conformance

## 0.1.0

### Minor Changes

- [#230](https://github.com/ascorbic/cirrus/pull/230) [`2261832`](https://github.com/ascorbic/cirrus/commit/2261832c3f158e4422b5079ed159d7e703a2bde4) Thanks [@ascorbic](https://github.com/ascorbic)! - First release of `@getcirrus/space-conformance`: a black-box conformance suite for atproto spaces implementations. This release carries the core check model (tiered MUST/SHOULD/INFO checks with machine-readable citations), the capability-aware catalog runner with honest skip reporting, the vendored spaces lexicons, and the coverage generator that derives required checks from every lexicon method and declared error name.

### Patch Changes

- [#255](https://github.com/ascorbic/cirrus/pull/255) [`de476f5`](https://github.com/ascorbic/cirrus/commit/de476f57ba1fb936c6480a8fc278b6c7fc250cab) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix fresh installs failing with `"@atproto/lex-data@workspace:*" is in the dependencies but no package named "@atproto/lex-data" is present in the workspace` (or `Unsupported URL Type "workspace:"` under npm). This affected new projects created with `create-pds`, as well as any project installing these packages without an existing lockfile.

- [#238](https://github.com/ascorbic/cirrus/pull/238) [`a55ac49`](https://github.com/ascorbic/cirrus/commit/a55ac492b556b4b294b28818a4eb3d0ff3664344) Thanks [@ascorbic](https://github.com/ascorbic)! - Probe spaces now use published, resolvable lexicons (`earth.cirrus.check.space` / `.note` / `.withblob`) instead of the unpublished `app.bsky.group` type and unresolvable `test.conformance.*` collections, so the suite works against implementations that resolve lexicons dynamically and validate strictly — not only against lenient targets.
