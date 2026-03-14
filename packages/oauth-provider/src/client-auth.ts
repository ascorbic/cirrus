/**
 * Client authentication for confidential clients using private_key_jwt
 * Implements RFC 7523 (JWT Bearer Client Authentication)
 */

import {
	jwtVerify,
	createLocalJWKSet,
	createRemoteJWKSet,
	errors,
	customFetch,
} from "jose";
import type { JWTPayload } from "jose";
import type { ClientMetadata } from "./storage.js";

const { JOSEError } = errors;

/** Expected assertion type for private_key_jwt */
export const JWT_BEARER_ASSERTION_TYPE =
	"urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Client authentication error
 */
export class ClientAuthError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = "ClientAuthError";
	}
}

/**
 * Result of client authentication
 */
export interface ClientAuthResult {
	/** Whether client authentication was performed */
	authenticated: boolean;
	/** The client ID from the assertion (if authenticated) */
	clientId?: string;
}

/**
 * Options for client authentication
 */
export interface ClientAuthOptions {
	/** Token endpoint URL (for audience validation) */
	tokenEndpoint: string;
	/** Issuer URL (also accepted as audience per RFC 7523) */
	issuer: string;
	/** Fetch function for fetching remote JWKS (for testing) */
	fetch?: typeof globalThis.fetch;
	/** Check if a JTI has been used (for replay prevention) */
	checkJti?: (jti: string) => Promise<boolean>;
}

/**
 * Parse client assertion from request parameters
 */
export function parseClientAssertion(params: Record<string, string>): {
	assertionType?: string;
	assertion?: string;
} {
	return {
		assertionType: params.client_assertion_type,
		assertion: params.client_assertion,
	};
}

/**
 * Verify a client assertion JWT
 * @param assertion The JWT assertion
 * @param client The client metadata (with JWKS)
 * @param options Verification options
 * @returns The verified JWT payload
 * @throws ClientAuthError if verification fails
 */
export async function verifyClientAssertion(
	assertion: string,
	client: ClientMetadata,
	options: ClientAuthOptions,
): Promise<JWTPayload> {
	const {
		tokenEndpoint,
		issuer,
		fetch: fetchFn = globalThis.fetch.bind(globalThis),
		checkJti,
	} = options;

	// Get the key resolver
	let keyResolver: Parameters<typeof jwtVerify>[1];

	// Resolve JWKS from inline keys or remote URI
	let jwks: { keys: Record<string, unknown>[] } | undefined;
	if (client.jwks && client.jwks.keys.length > 0) {
		jwks = client.jwks;
	} else if (client.jwksUri) {
		const res = await fetchFn(client.jwksUri, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			throw new ClientAuthError(
				`Failed to fetch client JWKS: ${res.status}`,
				"invalid_client",
			);
		}
		jwks = await res.json();
	}

	if (!jwks?.keys?.length) {
		throw new ClientAuthError(
			"Client has no JWKS configured",
			"invalid_client",
		);
	}

	// Strip key_ops before importing — clients in the wild include
	// invalid operations like "encrypt" on ECDSA signing keys, which
	// causes Web Crypto to reject the import. The algorithm is already
	// constrained to ES256 by the jwtVerify options below.
	keyResolver = createLocalJWKSet({
		keys: jwks.keys.map(({ key_ops, ...rest }) => rest),
	});

	let payload: JWTPayload;
	try {
		const result = await jwtVerify(assertion, keyResolver, {
			algorithms: ["ES256"], // ATProto requires ES256
			clockTolerance: 30, // 30 seconds clock skew tolerance
			maxTokenAge: "5m", // JWTs should be short-lived
		});
		payload = result.payload;
	} catch (err) {
		if (err instanceof JOSEError) {
			throw new ClientAuthError(
				`JWT verification failed: ${err.message}`,
				"invalid_client",
			);
		}
		throw new ClientAuthError(
			`JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
			"invalid_client",
		);
	}

	// Validate required claims per RFC 7523

	// iss (issuer) must equal client_id
	if (payload.iss !== client.clientId) {
		throw new ClientAuthError(
			`JWT issuer mismatch: expected ${client.clientId}, got ${payload.iss}`,
			"invalid_client",
		);
	}

	// sub (subject) must equal client_id
	if (payload.sub !== client.clientId) {
		throw new ClientAuthError(
			`JWT subject mismatch: expected ${client.clientId}, got ${payload.sub}`,
			"invalid_client",
		);
	}

	// aud (audience) must include the token endpoint or the issuer
	// Per RFC 7523, audience identifies the authorization server - both formats are valid
	const aud = Array.isArray(payload.aud)
		? payload.aud
		: payload.aud
			? [payload.aud]
			: [];
	if (!aud.includes(tokenEndpoint) && !aud.includes(issuer)) {
		throw new ClientAuthError(
			`JWT audience must include token endpoint (${tokenEndpoint}) or issuer (${issuer})`,
			"invalid_client",
		);
	}

	// jti (JWT ID) must be present and unique
	if (!payload.jti) {
		throw new ClientAuthError("JWT must include jti claim", "invalid_client");
	}

	// Check jti for replay prevention if callback provided
	if (checkJti) {
		const isUnique = await checkJti(payload.jti);
		if (!isUnique) {
			throw new ClientAuthError(
				"JWT has already been used (replay detected)",
				"invalid_client",
			);
		}
	}

	// iat (issued at) must be present (verified by jose maxTokenAge)
	if (!payload.iat) {
		throw new ClientAuthError("JWT must include iat claim", "invalid_client");
	}

	return payload;
}

/**
 * Authenticate a client from request parameters
 * @param params Request parameters containing client_id, client_assertion_type, client_assertion
 * @param getClient Function to resolve client metadata
 * @param options Authentication options
 * @returns Authentication result
 * @throws ClientAuthError if authentication fails
 */
export async function authenticateClient(
	params: Record<string, string>,
	getClient: (clientId: string) => Promise<ClientMetadata | null>,
	options: ClientAuthOptions,
): Promise<ClientAuthResult> {
	const clientId = params.client_id;
	if (!clientId) {
		throw new ClientAuthError("Missing client_id", "invalid_request");
	}

	const { assertionType, assertion } = parseClientAssertion(params);

	// Resolve client metadata
	const client = await getClient(clientId);
	if (!client) {
		throw new ClientAuthError(`Unknown client: ${clientId}`, "invalid_client");
	}

	const authMethod = client.tokenEndpointAuthMethod ?? "none";

	// Public client (no authentication required)
	if (authMethod === "none") {
		// If assertion is provided for public client, that's an error
		if (assertion || assertionType) {
			throw new ClientAuthError(
				"Client assertion not expected for public client",
				"invalid_request",
			);
		}
		return { authenticated: false, clientId };
	}

	// Confidential client (private_key_jwt required)
	if (authMethod === "private_key_jwt") {
		if (!assertionType || !assertion) {
			throw new ClientAuthError(
				"Client assertion required for confidential client",
				"invalid_client",
			);
		}

		if (assertionType !== JWT_BEARER_ASSERTION_TYPE) {
			throw new ClientAuthError(
				`Unsupported assertion type: ${assertionType}. Expected: ${JWT_BEARER_ASSERTION_TYPE}`,
				"invalid_client",
			);
		}

		// Verify the JWT assertion
		await verifyClientAssertion(assertion, client, options);

		return { authenticated: true, clientId };
	}

	throw new ClientAuthError(
		`Unsupported auth method: ${authMethod}`,
		"invalid_client",
	);
}
