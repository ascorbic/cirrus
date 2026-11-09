/**
 * @getcirrus/space-conformance – black-box conformance suite for atproto
 * spaces implementations (alpha).
 *
 * One check model, multiple runners: the same tiered, citation-carrying
 * checks run in-process against a local implementation, from a CLI against
 * a live host, or inside a web checker. `must` checks cite specified
 * behaviour; `should` checks are calibrated against the reference
 * implementation; `info` checks never fail anyone.
 */

export { pass, fail } from "./model.js";
export type {
	Capability,
	Check,
	CheckContext,
	CheckOutcome,
	CheckResult,
	CheckStatus,
	Citation,
	HarnessIdentity,
	IdentityProvider,
	InboxDelivery,
	SyncerInbox,
	Target,
	Tier,
} from "./model.js";

export { buildCatalog, defineCheck, filterCatalog } from "./registry.js";
export type { CatalogFilter, FilteredCatalog } from "./registry.js";

export { xrpcGet, xrpcPost, xrpcUrl, operatorHeaders } from "./http.js";
export type { XrpcResult } from "./http.js";

export { baseChecks } from "./checks/base.js";
export {
	operatorChecks,
	createProbeSpace,
	deleteProbeSpace,
	operatorCreateRecord,
	obtainCredentialViaDelegation,
	obtainPublicCredential,
	requestCredential,
	credentialCall,
	credentialGet,
	memberspace,
	personalspace,
	managedspace,
	publicRead,
} from "./checks/operator.js";
export type {
	Credential,
	CredentialCallOptions,
	CredentialResult,
	Policy,
	ProbeSpace,
} from "./checks/operator.js";

export {
	createCredentialKey,
	encapsulate,
	formatWantMacHeader,
	isP256DidKey,
	spaceSigHeaders,
	COMMIT_MAC_TYPE,
	RECORD_MAC_TYPE,
	SPACE_CREDENTIAL_SCHEME,
} from "./space-auth.js";
export type { CredentialKey, MacType } from "./space-auth.js";
export {
	DEFAULT_PLC_DIRECTORY,
	didDocumentUrl,
	resolveDidDocument,
	serviceEndpoint,
	verificationMethodDidKey,
} from "./did.js";
export type { DidDocument } from "./did.js";

export { cryptoCheckDescriptors, descriptorToStub } from "./descriptors.js";
export type { CheckDescriptor } from "./descriptors.js";

export { ALPHA_BUILD } from "./alpha.js";
export { knownChangesets } from "./changesets.js";

import { baseChecks as base } from "./checks/base.js";
import { operatorChecks as operator } from "./checks/operator.js";
import { buildCatalog as build } from "./registry.js";
import {
	cryptoCheckDescriptors as descriptors,
	descriptorToStub as stub,
} from "./descriptors.js";

/**
 * A catalog for transports that cannot run the crypto-bound checks (the
 * browser). The base checks run anonymously; the operator checks — writes,
 * space management, blobs, credential issuance and presentation — are real
 * and run whenever the harness supplies an operator session (an OAuth
 * sign-in in the web checker). Only the checks that genuinely need the
 * alpha crypto libs or foreign identities are metadata stubs, reported as
 * skipped ("not testable here") — listed rather than omitted, so a green
 * run never silently reads as fuller conformance than it proved.
 */
export const browserCatalog = build([
	...base,
	...operator,
	...descriptors.map(stub),
]);

export { renderReport, runChecks } from "./runner.js";
export type { RunOptions, RunReport } from "./runner.js";

export {
	coverageExemptions,
	coverageReport,
	coverageRequirements,
} from "./coverage.js";
export type {
	CoverageExemption,
	CoverageReport,
	CoverageRequirement,
} from "./coverage.js";

export { lexicons } from "./lexicons.js";
export type { LexiconDoc } from "./lexicons.js";
