/**
 * The full check catalog and the identity provider.
 *
 * This entry imports `@atproto/space`, so it pulls the alpha crypto libs
 * and their (node-ish) transitive graph. Import it from the CLI and the
 * vitest adapter — anywhere WebCrypto and the alpha libs run — but never
 * from a browser bundle. The browser adapter imports the base catalog from
 * the package root instead.
 */

import { buildCatalog } from "./registry.js";
import { baseChecks } from "./checks/base.js";
import { operatorChecks } from "./checks/operator.js";
import { cryptoChecks } from "./full/checks.js";

export { KeypairIdentityProvider, createCredentialKey } from "./identity.js";
export type {
	CredentialKey,
	HarnessIdentityWithKey,
	IdentityDocumentOptions,
} from "./identity.js";

export {
	createProbeSpace,
	deleteProbeSpace,
	obtainCredential,
	obtainCredentialViaDelegation,
	obtainPublicCredential,
	credentialCall,
	credentialGet,
	requestCredential,
	mintCredential,
	mintDelegation,
	serviceJwt,
	operatorCreateRecord,
} from "./full/helpers.js";
export type { Credential, ProbeSpace } from "./full/helpers.js";

export { createSyncerInbox } from "./inbox.js";
export type { SyncerInboxHandle } from "./inbox.js";

export { cryptoChecks } from "./full/checks.js";
export { operatorChecks } from "./checks/operator.js";
export { baseChecks } from "./checks/base.js";

/**
 * The complete catalog: the browser-safe base and operator checks plus
 * the crypto-bound ones only this entry can run.
 */
export const fullCatalog = buildCatalog([
	...baseChecks,
	...operatorChecks,
	...cryptoChecks,
]);
