import type { AuthVariables } from "./middleware/auth";
import type { AccountDurableObject } from "./account-do";

/**
 * Data location options for Durable Object placement.
 *
 * - "auto": No location constraint (default, recommended)
 * - "eu": European Union - hard guarantee data never leaves EU
 * - Location hints (best-effort, not guaranteed):
 *   - "wnam": Western North America
 *   - "enam": Eastern North America
 *   - "sam": South America
 *   - "weur": Western Europe
 *   - "eeur": Eastern Europe
 *   - "apac": Asia-Pacific
 *   - "oc": Oceania
 *   - "afr": Africa
 *   - "me": Middle East
 *
 * IMPORTANT: This setting only affects newly-created Durable Objects.
 * Changing this after initial deployment will NOT migrate existing data.
 * To relocate data, you must export and re-import to a new PDS.
 */
export type DataLocation =
	| "auto" // No location constraint (default)
	| "eu" // European Union (jurisdiction - hard guarantee)
	| "wnam" // Western North America (hint)
	| "enam" // Eastern North America (hint)
	| "sam" // South America (hint)
	| "weur" // Western Europe (hint)
	| "eeur" // Eastern Europe (hint)
	| "apac" // Asia-Pacific (hint)
	| "oc" // Oceania (hint)
	| "afr" // Africa (hint)
	| "me"; // Middle East (hint)

/**
 * Environment bindings required by the PDS worker.
 * Consumers must provide these bindings in their wrangler config.
 */
export interface PDSEnv {
	/** The account's DID (e.g., did:web:example.com) */
	DID: string;
	/** The account's handle (e.g., alice.example.com) */
	HANDLE: string;
	/** Public hostname of the PDS */
	PDS_HOSTNAME: string;
	/** Bearer token for write operations */
	AUTH_TOKEN: string;
	/** Private signing key (hex-encoded) */
	SIGNING_KEY: string;
	/** Public signing key (multibase-encoded) */
	SIGNING_KEY_PUBLIC: string;
	/** Secret for signing session JWTs */
	JWT_SECRET: string;
	/** Bcrypt hash of account password */
	PASSWORD_HASH: string;
	/** Durable Object namespace for account storage */
	ACCOUNT: DurableObjectNamespace<AccountDurableObject>;
	/** R2 bucket for blob storage (optional) */
	BLOBS?: R2Bucket;
	/** Initial activation state for new accounts (default: true) */
	INITIAL_ACTIVE?: string;
	/**
	 * Data location for Durable Object placement.
	 *
	 * WARNING: DO NOT CHANGE THIS AFTER INITIAL DEPLOYMENT.
	 * This setting only affects newly-created DOs. Changing it will NOT
	 * migrate existing data and may cause issues.
	 *
	 * Options:
	 * - "auto" or unset: No location constraint (default, recommended)
	 * - "eu": European Union - hard guarantee data never leaves EU
	 * - Location hints (best-effort, not guaranteed):
	 *   "wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"
	 */
	DATA_LOCATION?: DataLocation;
}

/**
 * Base app environment with bindings only.
 * Used for routes that don't require authentication.
 */
export type AppEnv = {
	Bindings: PDSEnv;
};

/**
 * App environment with auth variables.
 * Used for routes that require authentication.
 */
export type AuthedAppEnv = {
	Bindings: PDSEnv;
	Variables: AuthVariables;
};
