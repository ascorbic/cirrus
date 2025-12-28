import type { Context } from "hono";
import type { AuthVariables } from "./middleware/auth";
import type { AccountDurableObject } from "./account-do";

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

/**
 * Context type for handlers that work with or without auth.
 * Uses a generic to accept either authenticated or unauthenticated contexts.
 */
export type AppContext<E extends AppEnv = AppEnv> = Context<E>;
