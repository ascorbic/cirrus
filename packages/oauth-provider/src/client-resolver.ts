/**
 * Client resolver for DID-based client discovery
 * Resolves OAuth client metadata from DIDs for AT Protocol
 */

import { ensureValidDid } from "@atproto/syntax";
import {
	oauthClientMetadataSchema,
	type OAuthClientMetadata,
} from "@atproto/oauth-types";
import type { ClientMetadata, OAuthStorage, JWK } from "./storage.js";

export type { OAuthClientMetadata };

/**
 * Client resolution error
 */
export class ClientResolutionError extends Error {
	constructor(
		message: string,
		public readonly code: string
	) {
		super(message);
		this.name = "ClientResolutionError";
	}
}

/**
 * Options for client resolution
 */
export interface ClientResolverOptions {
	/** Storage for caching client metadata */
	storage?: OAuthStorage;
	/** Cache TTL in milliseconds (default: 1 hour) */
	cacheTtl?: number;
	/** Fetch function for making HTTP requests (for testing) */
	fetch?: typeof globalThis.fetch;
}

/**
 * Check if a string is a valid HTTPS URL
 */
function isHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Check if a client ID is a valid localhost client per AT Protocol spec.
 * Localhost clients use http://localhost with no port, and encode
 * redirect_uri and scope as query parameters.
 * @see https://atproto.com/specs/oauth#clients
 */
function isLocalhostClient(value: string): boolean {
	try {
		const url = new URL(value);
		// Must be http://localhost with no port
		return url.protocol === "http:" && url.hostname === "localhost" && !url.port;
	} catch {
		return false;
	}
}

/**
 * Parse localhost client metadata from the client_id URL.
 * Per AT Protocol spec, redirect_uri and scope are encoded as query params.
 * Defaults to http://127.0.0.1/ and http://[::1]/ for redirect URIs.
 */
function parseLocalhostClientMetadata(clientId: string): ClientMetadata {
	const url = new URL(clientId);

	// Get redirect_uri from query params, default to loopback addresses
	const redirectUriParam = url.searchParams.get("redirect_uri");
	const redirectUris = redirectUriParam
		? [redirectUriParam]
		: ["http://127.0.0.1/", "http://[::1]/"];

	// Scope is informational for localhost clients
	const scope = url.searchParams.get("scope") ?? "atproto";

	return {
		clientId,
		clientName: "Localhost Client",
		redirectUris,
		tokenEndpointAuthMethod: "none", // Localhost clients are always public
		cachedAt: Date.now(),
	};
}

/**
 * Validate that a string is a valid DID using @atproto/syntax
 */
function isValidDid(value: string): boolean {
	try {
		ensureValidDid(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the client metadata URL from a client ID
 * Supports both URL-based and DID-based client IDs
 */
function getClientMetadataUrl(clientId: string): string | null {
	// URL-based client ID: the URL itself is the metadata endpoint
	if (isHttpsUrl(clientId)) {
		return clientId;
	}

	// DID-based client ID: derive the metadata URL
	if (clientId.startsWith("did:web:")) {
		// did:web:example.com -> https://example.com/.well-known/oauth-client-metadata
		// did:web:example.com:path -> https://example.com/path/.well-known/oauth-client-metadata
		const parts = clientId.slice(8).split(":");
		const host = parts[0]!.replace(/%3A/g, ":");
		const path = parts.slice(1).join("/");
		const baseUrl = `https://${host}${path ? "/" + path : ""}`;
		return `${baseUrl}/.well-known/oauth-client-metadata`;
	}

	// Unsupported client ID format
	return null;
}

/**
 * Resolve client metadata from a DID
 */
export class ClientResolver {
	private storage?: OAuthStorage;
	private cacheTtl: number;
	private fetchFn: typeof globalThis.fetch;

	constructor(options: ClientResolverOptions = {}) {
		this.storage = options.storage;
		this.cacheTtl = options.cacheTtl ?? 60 * 60 * 1000; // 1 hour default
		this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	/**
	 * Resolve client metadata from a client ID (URL or DID)
	 * @param clientId The client ID (HTTPS URL, DID, or localhost URL)
	 * @returns The client metadata
	 * @throws ClientResolutionError if resolution fails
	 */
	async resolveClient(clientId: string): Promise<ClientMetadata> {
		// Handle localhost clients per AT Protocol spec
		// These don't need network resolution - metadata is in the URL
		if (isLocalhostClient(clientId)) {
			return parseLocalhostClientMetadata(clientId);
		}

		if (!isHttpsUrl(clientId) && !isValidDid(clientId)) {
			throw new ClientResolutionError(
				`Invalid client ID format: ${clientId}`,
				"invalid_client"
			);
		}

		if (this.storage) {
			const cached = await this.storage.getClient(clientId);
			// Check cache validity: must have timestamp, not expired, and have auth method set
			// (entries without tokenEndpointAuthMethod are from before we added that field)
			if (cached && cached.cachedAt &&
				Date.now() - cached.cachedAt < this.cacheTtl &&
				cached.tokenEndpointAuthMethod !== undefined) {
				return cached;
			}
		}

		const metadataUrl = getClientMetadataUrl(clientId);
		if (!metadataUrl) {
			throw new ClientResolutionError(
				`Unsupported client ID format: ${clientId}`,
				"invalid_client"
			);
		}

		let response: Response;
		try {
			response = await this.fetchFn(metadataUrl, {
				headers: {
					Accept: "application/json",
				},
			});
		} catch (e) {
			throw new ClientResolutionError(
				`Failed to fetch client metadata: ${e}`,
				"invalid_client"
			);
		}

		if (!response.ok) {
			throw new ClientResolutionError(
				`Client metadata fetch failed with status ${response.status}`,
				"invalid_client"
			);
		}

		let doc: OAuthClientMetadata;
		try {
			const json = await response.json();
			doc = oauthClientMetadataSchema.parse(json);
		} catch (e) {
			throw new ClientResolutionError(
				`Invalid client metadata: ${e instanceof Error ? e.message : "validation failed"}`,
				"invalid_client"
			);
		}

		if (doc.client_id !== clientId) {
			throw new ClientResolutionError(
				`Client ID mismatch: expected ${clientId}, got ${doc.client_id}`,
				"invalid_client"
			);
		}

		const metadata: ClientMetadata = {
			clientId: doc.client_id,
			clientName: doc.client_name ?? clientId,
			redirectUris: doc.redirect_uris,
			logoUri: doc.logo_uri,
			clientUri: doc.client_uri,
			tokenEndpointAuthMethod: (doc.token_endpoint_auth_method as "none" | "private_key_jwt") ?? "none",
			jwks: doc.jwks as { keys: JWK[] } | undefined,
			jwksUri: doc.jwks_uri,
			cachedAt: Date.now(),
		};

		if (this.storage) {
			await this.storage.saveClient(clientId, metadata);
		}

		return metadata;
	}

	/**
	 * Validate that a redirect URI is allowed for a client
	 * @param clientId The client ID (URL or DID)
	 * @param redirectUri The redirect URI to validate
	 * @returns true if the redirect URI is allowed
	 */
	async validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
		try {
			const metadata = await this.resolveClient(clientId);

			// For localhost clients, use relaxed matching per AT Protocol spec:
			// Port numbers are not matched, only scheme, host, and path
			if (isLocalhostClient(clientId)) {
				return this.matchesLocalhostRedirectUri(metadata.redirectUris, redirectUri);
			}

			return metadata.redirectUris.includes(redirectUri);
		} catch {
			return false;
		}
	}

	/**
	 * Check if a redirect URI matches any allowed URI for localhost clients.
	 * Per AT Protocol spec, port numbers are not matched for localhost.
	 */
	private matchesLocalhostRedirectUri(allowedUris: string[], redirectUri: string): boolean {
		try {
			const redirect = new URL(redirectUri);

			for (const allowed of allowedUris) {
				const allowedUrl = new URL(allowed);
				// Match scheme, hostname, and path - ignore port
				if (
					redirect.protocol === allowedUrl.protocol &&
					redirect.hostname === allowedUrl.hostname &&
					redirect.pathname === allowedUrl.pathname
				) {
					return true;
				}
			}
			return false;
		} catch {
			return false;
		}
	}
}

/**
 * Create a client resolver with optional caching
 */
export function createClientResolver(options: ClientResolverOptions = {}): ClientResolver {
	return new ClientResolver(options);
}
