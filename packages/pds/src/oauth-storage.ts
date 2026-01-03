import type {
	AuthCodeData,
	ClientMetadata,
	OAuthStorage,
	PARData,
	TokenData,
} from "@getcirrus/oauth-provider";

/**
 * SQLite-backed OAuth storage for Cloudflare Durable Objects.
 *
 * Implements the OAuthStorage interface from @getcirrus/oauth-provider,
 * storing OAuth data in SQLite tables within a Durable Object.
 */
export class SqliteOAuthStorage implements OAuthStorage {
	constructor(private sql: SqlStorage) {}

	/**
	 * Initialize the OAuth database schema. Should be called once on DO startup.
	 */
	initSchema(): void {
		this.sql.exec(`
			-- Authorization codes (5 min TTL)
			CREATE TABLE IF NOT EXISTS oauth_auth_codes (
				code TEXT PRIMARY KEY,
				client_id TEXT NOT NULL,
				redirect_uri TEXT NOT NULL,
				code_challenge TEXT NOT NULL,
				code_challenge_method TEXT NOT NULL DEFAULT 'S256',
				scope TEXT NOT NULL,
				sub TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON oauth_auth_codes(expires_at);

			-- OAuth tokens
			CREATE TABLE IF NOT EXISTS oauth_tokens (
				access_token TEXT PRIMARY KEY,
				refresh_token TEXT NOT NULL UNIQUE,
				client_id TEXT NOT NULL,
				sub TEXT NOT NULL,
				scope TEXT NOT NULL,
				dpop_jkt TEXT,
				issued_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				revoked INTEGER NOT NULL DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS idx_tokens_refresh ON oauth_tokens(refresh_token);
			CREATE INDEX IF NOT EXISTS idx_tokens_sub ON oauth_tokens(sub);
			CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens(expires_at);

			-- Cached client metadata
			CREATE TABLE IF NOT EXISTS oauth_clients (
				client_id TEXT PRIMARY KEY,
				client_name TEXT NOT NULL,
				redirect_uris TEXT NOT NULL,
				logo_uri TEXT,
				client_uri TEXT,
				cached_at INTEGER NOT NULL
			);

			-- PAR requests (90 sec TTL)
			CREATE TABLE IF NOT EXISTS oauth_par_requests (
				request_uri TEXT PRIMARY KEY,
				client_id TEXT NOT NULL,
				params TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_par_expires ON oauth_par_requests(expires_at);

			-- DPoP nonces for replay prevention (5 min TTL)
			CREATE TABLE IF NOT EXISTS oauth_nonces (
				nonce TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_nonces_created ON oauth_nonces(created_at);
		`);
	}

	/**
	 * Clean up expired entries. Should be called periodically.
	 */
	cleanup(): void {
		const now = Date.now();
		this.sql.exec("DELETE FROM oauth_auth_codes WHERE expires_at < ?", now);
		this.sql.exec(
			"DELETE FROM oauth_tokens WHERE expires_at < ? AND revoked = 0",
			now,
		);
		this.sql.exec("DELETE FROM oauth_par_requests WHERE expires_at < ?", now);
		// Nonces expire after 5 minutes
		const nonceExpiry = now - 5 * 60 * 1000;
		this.sql.exec("DELETE FROM oauth_nonces WHERE created_at < ?", nonceExpiry);
	}

	// ============================================
	// Authorization Codes
	// ============================================

	async saveAuthCode(code: string, data: AuthCodeData): Promise<void> {
		this.sql.exec(
			`INSERT INTO oauth_auth_codes
			(code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, sub, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			code,
			data.clientId,
			data.redirectUri,
			data.codeChallenge,
			data.codeChallengeMethod,
			data.scope,
			data.sub,
			data.expiresAt,
		);
	}

	async getAuthCode(code: string): Promise<AuthCodeData | null> {
		const rows = this.sql
			.exec(
				`SELECT client_id, redirect_uri, code_challenge, code_challenge_method, scope, sub, expires_at
				FROM oauth_auth_codes WHERE code = ?`,
				code,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		const expiresAt = row.expires_at as number;

		if (Date.now() > expiresAt) {
			this.sql.exec("DELETE FROM oauth_auth_codes WHERE code = ?", code);
			return null;
		}

		return {
			clientId: row.client_id as string,
			redirectUri: row.redirect_uri as string,
			codeChallenge: row.code_challenge as string,
			codeChallengeMethod: row.code_challenge_method as "S256",
			scope: row.scope as string,
			sub: row.sub as string,
			expiresAt,
		};
	}

	async deleteAuthCode(code: string): Promise<void> {
		this.sql.exec("DELETE FROM oauth_auth_codes WHERE code = ?", code);
	}

	// ============================================
	// Tokens
	// ============================================

	async saveTokens(data: TokenData): Promise<void> {
		this.sql.exec(
			`INSERT INTO oauth_tokens
			(access_token, refresh_token, client_id, sub, scope, dpop_jkt, issued_at, expires_at, revoked)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			data.accessToken,
			data.refreshToken,
			data.clientId,
			data.sub,
			data.scope,
			data.dpopJkt ?? null,
			data.issuedAt,
			data.expiresAt,
			data.revoked ? 1 : 0,
		);
	}

	async getTokenByAccess(accessToken: string): Promise<TokenData | null> {
		const rows = this.sql
			.exec(
				`SELECT access_token, refresh_token, client_id, sub, scope, dpop_jkt, issued_at, expires_at, revoked
				FROM oauth_tokens WHERE access_token = ?`,
				accessToken,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		const revoked = Boolean(row.revoked);
		const expiresAt = row.expires_at as number;

		if (revoked || Date.now() > expiresAt) {
			return null;
		}

		return {
			accessToken: row.access_token as string,
			refreshToken: row.refresh_token as string,
			clientId: row.client_id as string,
			sub: row.sub as string,
			scope: row.scope as string,
			dpopJkt: (row.dpop_jkt as string) ?? undefined,
			issuedAt: row.issued_at as number,
			expiresAt,
			revoked,
		};
	}

	async getTokenByRefresh(refreshToken: string): Promise<TokenData | null> {
		const rows = this.sql
			.exec(
				`SELECT access_token, refresh_token, client_id, sub, scope, dpop_jkt, issued_at, expires_at, revoked
				FROM oauth_tokens WHERE refresh_token = ?`,
				refreshToken,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		const revoked = Boolean(row.revoked);

		if (revoked) return null;

		return {
			accessToken: row.access_token as string,
			refreshToken: row.refresh_token as string,
			clientId: row.client_id as string,
			sub: row.sub as string,
			scope: row.scope as string,
			dpopJkt: (row.dpop_jkt as string) ?? undefined,
			issuedAt: row.issued_at as number,
			expiresAt: row.expires_at as number,
			revoked,
		};
	}

	async revokeToken(accessToken: string): Promise<void> {
		this.sql.exec(
			"UPDATE oauth_tokens SET revoked = 1 WHERE access_token = ?",
			accessToken,
		);
	}

	async revokeAllTokens(sub: string): Promise<void> {
		this.sql.exec("UPDATE oauth_tokens SET revoked = 1 WHERE sub = ?", sub);
	}

	// ============================================
	// Clients
	// ============================================

	async saveClient(clientId: string, metadata: ClientMetadata): Promise<void> {
		this.sql.exec(
			`INSERT OR REPLACE INTO oauth_clients
			(client_id, client_name, redirect_uris, logo_uri, client_uri, cached_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			clientId,
			metadata.clientName,
			JSON.stringify(metadata.redirectUris),
			metadata.logoUri ?? null,
			metadata.clientUri ?? null,
			metadata.cachedAt ?? Date.now(),
		);
	}

	async getClient(clientId: string): Promise<ClientMetadata | null> {
		const rows = this.sql
			.exec(
				`SELECT client_id, client_name, redirect_uris, logo_uri, client_uri, cached_at
				FROM oauth_clients WHERE client_id = ?`,
				clientId,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		return {
			clientId: row.client_id as string,
			clientName: row.client_name as string,
			redirectUris: JSON.parse(row.redirect_uris as string) as string[],
			logoUri: (row.logo_uri as string) ?? undefined,
			clientUri: (row.client_uri as string) ?? undefined,
			cachedAt: row.cached_at as number,
		};
	}

	// ============================================
	// PAR Requests
	// ============================================

	async savePAR(requestUri: string, data: PARData): Promise<void> {
		this.sql.exec(
			`INSERT INTO oauth_par_requests (request_uri, client_id, params, expires_at)
			VALUES (?, ?, ?, ?)`,
			requestUri,
			data.clientId,
			JSON.stringify(data.params),
			data.expiresAt,
		);
	}

	async getPAR(requestUri: string): Promise<PARData | null> {
		const rows = this.sql
			.exec(
				`SELECT client_id, params, expires_at FROM oauth_par_requests WHERE request_uri = ?`,
				requestUri,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		const expiresAt = row.expires_at as number;

		if (Date.now() > expiresAt) {
			this.sql.exec(
				"DELETE FROM oauth_par_requests WHERE request_uri = ?",
				requestUri,
			);
			return null;
		}

		return {
			clientId: row.client_id as string,
			params: JSON.parse(row.params as string) as Record<string, string>,
			expiresAt,
		};
	}

	async deletePAR(requestUri: string): Promise<void> {
		this.sql.exec(
			"DELETE FROM oauth_par_requests WHERE request_uri = ?",
			requestUri,
		);
	}

	// ============================================
	// DPoP Nonces
	// ============================================

	async checkAndSaveNonce(nonce: string): Promise<boolean> {
		// Check if nonce already exists
		const rows = this.sql
			.exec("SELECT 1 FROM oauth_nonces WHERE nonce = ? LIMIT 1", nonce)
			.toArray();

		if (rows.length > 0) {
			return false; // Nonce already used
		}

		// Save the nonce
		this.sql.exec(
			"INSERT INTO oauth_nonces (nonce, created_at) VALUES (?, ?)",
			nonce,
			Date.now(),
		);

		return true;
	}

	/**
	 * Clear all OAuth data (for testing).
	 */
	destroy(): void {
		this.sql.exec("DELETE FROM oauth_auth_codes");
		this.sql.exec("DELETE FROM oauth_tokens");
		this.sql.exec("DELETE FROM oauth_clients");
		this.sql.exec("DELETE FROM oauth_par_requests");
		this.sql.exec("DELETE FROM oauth_nonces");
	}
}
