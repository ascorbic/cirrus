/**
 * @getcirrus/space-conformance – black-box conformance suite for atproto
 * spaces implementations (alpha).
 *
 * One check model, multiple runners: the same tiered, citation-carrying
 * checks run in-process against a local implementation, from a CLI against
 * a live host, or inside a web checker. `must` checks cite specified
 * behavior; `should` checks are calibrated against the reference
 * implementation; `info` checks never fail anyone.
 */

export {
	pass,
	fail,
} from "./model.js";
export type {
	Capability,
	Check,
	CheckContext,
	CheckOutcome,
	CheckResult,
	CheckStatus,
	Citation,
	DpopKey,
	HarnessIdentity,
	IdentityProvider,
	InboxDelivery,
	SyncerInbox,
	Target,
	Tier,
} from "./model.js";

export { buildCatalog, defineCheck, filterCatalog } from "./registry.js";
export type { CatalogFilter, FilteredCatalog } from "./registry.js";

export { renderReport, runChecks } from "./runner.js";
export type { RunOptions, RunReport } from "./runner.js";

export {
	coverageReport,
	coverageRequirements,
} from "./coverage.js";
export type { CoverageReport, CoverageRequirement } from "./coverage.js";

export { lexicons } from "./lexicons.js";
export type { LexiconDoc } from "./lexicons.js";
