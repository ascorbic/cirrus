/**
 * Operator checks: everything an authenticated session can prove with the
 * platform's own `fetch` and WebCrypto — no alpha crypto libs, no foreign
 * identities. They run wherever the base checks run, browsers included, as
 * long as the harness supplies an `operator` capability (and, for some,
 * `pds-blobs`, `pds-delegation` or a `syncer-inbox`).
 *
 * The split matters: checks live here or in `../full/checks.js` by what
 * they *actually import*, not by topic. Presenting a space credential —
 * a P-256 HTTP signature and a KEM key share — needs nothing a browser
 * lacks, so every check that only presents one belongs here; verifying the
 * MACs that come back needs the reference library, and lives there.
 */

import type { Check } from "../model.js";
import { credentialChecks } from "./credential.js";
import { hostChecks } from "./host.js";
import { recordChecks } from "./records.js";
import { spaceChecks } from "./space.js";

export {
	createProbeSpace,
	credentialCall,
	credentialGet,
	deleteProbeSpace,
	managedspace,
	memberspace,
	obtainCredentialViaDelegation,
	obtainPublicCredential,
	operatorCreateRecord,
	personalspace,
	publicRead,
	requestCredential,
} from "./probe.js";
export type {
	Credential,
	CredentialCallOptions,
	CredentialResult,
	Policy,
	ProbeSpace,
} from "./probe.js";

/**
 * The operator catalog: runnable anywhere the harness has an operator
 * session — browser included.
 */
export const operatorChecks: Check[] = [
	...recordChecks,
	...spaceChecks,
	...credentialChecks,
	...hostChecks,
];
