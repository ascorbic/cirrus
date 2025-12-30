/**
 * Client resolver for DID-based client discovery
 * Resolves OAuth client metadata from DIDs for AT Protocol
 */

import type { ClientMetadata, OAuthStorage } from "./storage.js";

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
 * Client metadata from OAuth client metadata document
 * Per AT Protocol OAuth spec
 */
export interface OAuthClientMetadataDocument {
	/** Client identifier (must match the DID) */
	client_id: string;
	/** Human-readable name */
	client_name?: string;
	/** Client homepage URL */
	client_uri?: string;
	/** Logo URL */
	logo_uri?: string;
	/** Redirect URIs */
	redirect_uris: string[];
	/** Grant types supported */
	grant_types?: string[];
	/** Response types supported */
	response_types?: string[];
	/** Token endpoint auth method */
	token_endpoint_auth_method?: string;
	/** Scope requested */
	scope?: string;
	/** DPoP bound access tokens required */
	dpop_bound_access_tokens?: boolean;
}

/**
 * Validate that a string is a valid DID
 */
function isValidDid(value: string): boolean {
	// Basic DID format validation
	// did:method:method-specific-id
	return /^did:[a-z]+:[a-zA-Z0-9._%-]+$/.test(value);
}

/**
 * Extract the client metadata URL from a DID
 * For did:web, this is the /.well-known/oauth-client-metadata endpoint
 */
function getClientMetadataUrl(did: string): string | null {
	if (did.startsWith("did:web:")) {
		// did:web:example.com -> https://example.com/.well-known/oauth-client-metadata
		// did:web:example.com:path -> https://example.com/path/.well-known/oauth-client-metadata
		const parts = did.slice(8).split(":");
		const host = parts[0]!.replace(/%3A/g, ":");
		const path = parts.slice(1).join("/");
		const baseUrl = `https://${host}${path ? "/" + path : ""}`;
		return `${baseUrl}/.well-known/oauth-client-metadata`;
	}

	// For other DID methods, we'd need a DID resolver
	// For now, return null to indicate unsupported
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
	 * Resolve client metadata from a client ID (DID)
	 * @param clientId The client DID
	 * @returns The client metadata
	 * @throws ClientResolutionError if resolution fails
	 */
	async resolveClient(clientId: string): Promise<ClientMetadata> {
		// 1. Validate client ID is a valid DID
		if (!isValidDid(clientId)) {
			throw new ClientResolutionError(
				`Invalid client ID format: ${clientId}`,
				"invalid_client"
			);
		}

		// 2. Check cache
		if (this.storage) {
			const cached = await this.storage.getClient(clientId);
			if (cached && cached.cachedAt && Date.now() - cached.cachedAt < this.cacheTtl) {
				return cached;
			}
		}

		// 3. Get metadata URL
		const metadataUrl = getClientMetadataUrl(clientId);
		if (!metadataUrl) {
			throw new ClientResolutionError(
				`Unsupported DID method for client: ${clientId}`,
				"invalid_client"
			);
		}

		// 4. Fetch metadata
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

		// 5. Parse and validate metadata
		let doc: OAuthClientMetadataDocument;
		try {
			doc = (await response.json()) as OAuthClientMetadataDocument;
		} catch {
			throw new ClientResolutionError(
				"Failed to parse client metadata JSON",
				"invalid_client"
			);
		}

		// 6. Validate client_id matches
		if (doc.client_id !== clientId) {
			throw new ClientResolutionError(
				`Client ID mismatch: expected ${clientId}, got ${doc.client_id}`,
				"invalid_client"
			);
		}

		// 7. Validate required fields
		if (!doc.redirect_uris || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
			throw new ClientResolutionError(
				"Client metadata must include at least one redirect_uri",
				"invalid_client"
			);
		}

		// 8. Build client metadata
		const metadata: ClientMetadata = {
			clientId: doc.client_id,
			clientName: doc.client_name ?? clientId,
			redirectUris: doc.redirect_uris,
			logoUri: doc.logo_uri,
			clientUri: doc.client_uri,
			cachedAt: Date.now(),
		};

		// 9. Cache metadata
		if (this.storage) {
			await this.storage.saveClient(clientId, metadata);
		}

		return metadata;
	}

	/**
	 * Validate that a redirect URI is allowed for a client
	 * @param clientId The client DID
	 * @param redirectUri The redirect URI to validate
	 * @returns true if the redirect URI is allowed
	 */
	async validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
		try {
			const metadata = await this.resolveClient(clientId);
			return metadata.redirectUris.includes(redirectUri);
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
