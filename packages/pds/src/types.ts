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
 * AT Protocol identity stored per-account in the Durable Object.
 * Generated during account creation and stored in SQLite.
 *
 * Note: For did:web DIDs, the DID and handle are derivable from each other
 * (e.g., did:web:123.fid.is <-> 123.fid.is), but both are stored for convenience.
 */
export interface AtprotoIdentity {
	/** The account's DID (e.g., did:web:123.fid.is) */
	did: string;
	/** The account's handle (e.g., 123.fid.is) */
	handle: string;
	/** Private signing key (hex-encoded) */
	signingKey: string;
	/** Public signing key (multibase-encoded) */
	signingKeyPublic: string;
}

/**
 * Environment bindings for the multi-tenant PDS.
 * AT Protocol identity is stored per-account in DO SQLite, not in env vars.
 */
export interface PDSEnv {
	/** Base domain for WebFID subdomains (e.g., "fid.is") */
	WEBFID_DOMAIN: string;
	/** Miniapp domain for Quick Auth JWT audience verification. Required for Quick Auth flows. */
	QUICKAUTH_DOMAIN?: string;
	/** Secret for signing session JWTs */
	JWT_SECRET: string;
	/** Durable Object namespace for account storage */
	ACCOUNT: DurableObjectNamespace<AccountDurableObject>;
	/** R2 bucket for blob storage (optional) */
	BLOBS?: R2Bucket;
	/** Account email address (optional, used by some clients) */
	EMAIL?: string;
	/** D1 database for global user registry (optional) */
	USER_REGISTRY?: D1Database;
	/** Initial activation state for new accounts (default: true) */
	INITIAL_ACTIVE?: string;
	/** When "true", only FIDs on the allowlist can create accounts */
	ALLOWLIST_ENABLED?: string;
	/** Alchemy API key for Optimism RPC (used by SIWF verification) */
	ALCHEMY_API_KEY?: string;
	/** Optimism RPC URL for reading Farcaster contracts (IdRegistry) */
	OPTIMISM_RPC_URL?: string;
	/** x402 payment price in USD (e.g., "0.01") for agent account creation */
	X402_PRICE?: string;
	/** x402 facilitator URL for payment verification */
	X402_FACILITATOR_URL?: string;
	/** Wallet address to receive x402 payments */
	X402_PAY_TO?: string;
	/** x402 network in CAIP-2 format (default: "eip155:8453" for Base mainnet) */
	X402_NETWORK?: string;
	/** x402 USDC asset contract address (auto-detected from network if omitted) */
	X402_ASSET?: string;
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
 * Base app environment for multi-tenant PDS.
 * Used for routes that don't require authentication.
 */
export type AppEnv = {
	Bindings: PDSEnv;
	Variables: Partial<AuthVariables>;
};

/**
 * App environment with auth variables.
 * Used for routes that require authentication.
 */
export type AuthedAppEnv = {
	Bindings: PDSEnv;
	Variables: AuthVariables;
};
