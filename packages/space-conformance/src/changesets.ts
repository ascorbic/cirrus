/**
 * The upstream changesets the suite may cite, from bluesky-social/atproto
 * `permissioned-data-alpha` at the vendored commit (see
 * ../lexicons/MANIFEST.json). For alpha mechanics no lexicon can express —
 * the credential HTTP signature, the MAC exchange, key discovery — a
 * changeset is the alpha's only normative prose. Citations are checked
 * against this list, the same typo guard lexicon citations get; re-vendor
 * it alongside the lexicons.
 */
export const knownChangesets: readonly string[] = [
	"alpha-kem-key-backfill",
	"baseline-space-policies",
	"brave-spaces-exist",
	"clear-spaces-sweep",
	"funky-dryers-draw",
	"neat-guests-pull",
	"olive-crabs-fly",
	"open-spaces-greet",
	"plain-keys-resolve",
	"quiet-spaces-mac",
	"quiet-writers-leave",
	"small-hornets-jam",
	"space-takedown-parity",
	"star-spaces-shine",
	"sturdy-spaces-depart",
];
