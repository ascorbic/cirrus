/**
 * OAuth storage interface and types
 * Defines the storage abstraction for auth codes, tokens, clients, etc.
 */

/**
 * Data stored with an authorization code
 */
export interface AuthCodeData {
	/** Client DID that requested the code */
	clientId: string;
	/** Redirect URI used in the authorization request */
	redirectUri: string;
	/** PKCE code challenge */
	codeChallenge: string;
	/** PKCE challenge method (always S256 for AT Protocol) */
	codeChallengeMethod: "S256";
	/** Authorized scope */
	scope: string;
	/** User DID that authorized the request */
	sub: string;
	/** Expiration timestamp (Unix ms) */
	expiresAt: number;
}

/**
 * Data stored with access and refresh tokens
 */
export interface TokenData {
	/** Opaque access token */
	accessToken: string;
	/** Opaque refresh token */
	refreshToken: string;
	/** Client DID that received the token */
	clientId: string;
	/** User DID the token is for */
	sub: string;
	/** Authorized scope */
	scope: string;
	/** DPoP key thumbprint (for token binding) */
	dpopJkt?: string;
	/** Issuance timestamp (Unix ms) */
	issuedAt: number;
	/** Expiration timestamp (Unix ms) */
	expiresAt: number;
	/** Whether the token has been revoked */
	revoked?: boolean;
}

/**
 * OAuth client metadata (discovered from DID document)
 */
export interface ClientMetadata {
	/** Client DID */
	clientId: string;
	/** Human-readable client name */
	clientName: string;
	/** Allowed redirect URIs */
	redirectUris: string[];
	/** Client logo URI (optional) */
	logoUri?: string;
	/** Client homepage URI (optional) */
	clientUri?: string;
	/** When the metadata was cached (Unix ms) */
	cachedAt?: number;
}

/**
 * Data stored for Pushed Authorization Requests (PAR)
 */
export interface PARData {
	/** Client DID that pushed the request */
	clientId: string;
	/** All OAuth parameters from the push request */
	params: Record<string, string>;
	/** Expiration timestamp (Unix ms) */
	expiresAt: number;
}

/**
 * Storage interface for OAuth data
 * Implementations should handle TTL-based expiration
 */
export interface OAuthStorage {
	// ============================================
	// Authorization Codes (5 min TTL)
	// ============================================

	/**
	 * Save an authorization code
	 * @param code The authorization code
	 * @param data Associated data
	 */
	saveAuthCode(code: string, data: AuthCodeData): Promise<void>;

	/**
	 * Get authorization code data
	 * @param code The authorization code
	 * @returns The data or null if not found/expired
	 */
	getAuthCode(code: string): Promise<AuthCodeData | null>;

	/**
	 * Delete an authorization code (after use)
	 * @param code The authorization code
	 */
	deleteAuthCode(code: string): Promise<void>;

	// ============================================
	// Tokens
	// ============================================

	/**
	 * Save token data
	 * @param data The token data
	 */
	saveTokens(data: TokenData): Promise<void>;

	/**
	 * Get token data by access token
	 * @param accessToken The access token
	 * @returns The data or null if not found/expired/revoked
	 */
	getTokenByAccess(accessToken: string): Promise<TokenData | null>;

	/**
	 * Get token data by refresh token
	 * @param refreshToken The refresh token
	 * @returns The data or null if not found/expired/revoked
	 */
	getTokenByRefresh(refreshToken: string): Promise<TokenData | null>;

	/**
	 * Revoke a token by access token
	 * @param accessToken The access token to revoke
	 */
	revokeToken(accessToken: string): Promise<void>;

	/**
	 * Revoke all tokens for a user (for logout)
	 * @param sub The user DID
	 */
	revokeAllTokens?(sub: string): Promise<void>;

	// ============================================
	// Clients (DID-based, cached)
	// ============================================

	/**
	 * Save client metadata (cached from DID document)
	 * @param clientId The client DID
	 * @param metadata The client metadata
	 */
	saveClient(clientId: string, metadata: ClientMetadata): Promise<void>;

	/**
	 * Get cached client metadata
	 * @param clientId The client DID
	 * @returns The metadata or null if not cached
	 */
	getClient(clientId: string): Promise<ClientMetadata | null>;

	// ============================================
	// PAR Requests (90 sec TTL)
	// ============================================

	/**
	 * Save PAR request data
	 * @param requestUri The unique request URI
	 * @param data The PAR data
	 */
	savePAR(requestUri: string, data: PARData): Promise<void>;

	/**
	 * Get PAR request data
	 * @param requestUri The request URI
	 * @returns The data or null if not found/expired
	 */
	getPAR(requestUri: string): Promise<PARData | null>;

	/**
	 * Delete PAR request (after use - one-time use)
	 * @param requestUri The request URI
	 */
	deletePAR(requestUri: string): Promise<void>;

	// ============================================
	// DPoP Nonces (5 min TTL, replay prevention)
	// ============================================

	/**
	 * Check if a nonce has been used and save it if not
	 * Used for DPoP replay prevention
	 * @param nonce The nonce to check
	 * @returns true if the nonce is new (valid), false if already used
	 */
	checkAndSaveNonce(nonce: string): Promise<boolean>;
}

/**
 * In-memory storage implementation for testing
 */
export class InMemoryOAuthStorage implements OAuthStorage {
	private authCodes = new Map<string, AuthCodeData>();
	private tokens = new Map<string, TokenData>();
	private refreshTokenIndex = new Map<string, string>(); // refreshToken -> accessToken
	private clients = new Map<string, ClientMetadata>();
	private parRequests = new Map<string, PARData>();
	private nonces = new Set<string>();

	async saveAuthCode(code: string, data: AuthCodeData): Promise<void> {
		this.authCodes.set(code, data);
	}

	async getAuthCode(code: string): Promise<AuthCodeData | null> {
		const data = this.authCodes.get(code);
		if (!data) return null;
		if (Date.now() > data.expiresAt) {
			this.authCodes.delete(code);
			return null;
		}
		return data;
	}

	async deleteAuthCode(code: string): Promise<void> {
		this.authCodes.delete(code);
	}

	async saveTokens(data: TokenData): Promise<void> {
		this.tokens.set(data.accessToken, data);
		this.refreshTokenIndex.set(data.refreshToken, data.accessToken);
	}

	async getTokenByAccess(accessToken: string): Promise<TokenData | null> {
		const data = this.tokens.get(accessToken);
		if (!data) return null;
		if (data.revoked || Date.now() > data.expiresAt) {
			return null;
		}
		return data;
	}

	async getTokenByRefresh(refreshToken: string): Promise<TokenData | null> {
		const accessToken = this.refreshTokenIndex.get(refreshToken);
		if (!accessToken) return null;
		const data = this.tokens.get(accessToken);
		if (!data) return null;
		if (data.revoked) return null;
		// Refresh tokens don't use accessToken expiresAt
		return data;
	}

	async revokeToken(accessToken: string): Promise<void> {
		const data = this.tokens.get(accessToken);
		if (data) {
			data.revoked = true;
		}
	}

	async revokeAllTokens(sub: string): Promise<void> {
		for (const [, data] of this.tokens) {
			if (data.sub === sub) {
				data.revoked = true;
			}
		}
	}

	async saveClient(clientId: string, metadata: ClientMetadata): Promise<void> {
		this.clients.set(clientId, metadata);
	}

	async getClient(clientId: string): Promise<ClientMetadata | null> {
		return this.clients.get(clientId) ?? null;
	}

	async savePAR(requestUri: string, data: PARData): Promise<void> {
		this.parRequests.set(requestUri, data);
	}

	async getPAR(requestUri: string): Promise<PARData | null> {
		const data = this.parRequests.get(requestUri);
		if (!data) return null;
		if (Date.now() > data.expiresAt) {
			this.parRequests.delete(requestUri);
			return null;
		}
		return data;
	}

	async deletePAR(requestUri: string): Promise<void> {
		this.parRequests.delete(requestUri);
	}

	async checkAndSaveNonce(nonce: string): Promise<boolean> {
		if (this.nonces.has(nonce)) {
			return false;
		}
		this.nonces.add(nonce);
		// Auto-cleanup old nonces after 5 minutes
		setTimeout(
			() => {
				this.nonces.delete(nonce);
			},
			5 * 60 * 1000
		);
		return true;
	}

	/** Clear all stored data (for testing) */
	clear(): void {
		this.authCodes.clear();
		this.tokens.clear();
		this.refreshTokenIndex.clear();
		this.clients.clear();
		this.parRequests.clear();
		this.nonces.clear();
	}
}
