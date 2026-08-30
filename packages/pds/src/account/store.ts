import { RpcTarget } from "cloudflare:workers";

/**
 * Convert SQLite's `datetime('now')` output ("YYYY-MM-DD HH:MM:SS" in UTC) to
 * an RFC 3339 / ISO 8601 string for lexicon-compliant API responses. Returns
 * the input unchanged when it already parses as a date (e.g. ISO strings
 * written by application code).
 */
function sqliteDatetimeToIso(value: string): string {
	if (value.includes("T")) return value;
	const iso = value.replace(" ", "T") + "Z";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString();
}

/**
 * SQLite-backed storage for person-account data: preferences, email,
 * passkeys, and app passwords. Shares the Durable Object's SQLite database
 * with SqliteRepoStorage; the email accessors read the email column of the
 * repo_state table, whose schema SqliteRepoStorage owns.
 *
 * Extends RpcTarget so the Durable Object can hand it to the Worker as a
 * stub (via account()) — callers invoke store methods directly over RPC.
 */
export class AccountStore extends RpcTarget {
	constructor(private sql: SqlStorage) {
		super();
	}

	initSchema(): void {
		this.sql.exec(`
			-- User preferences (single row, stores JSON array)
			CREATE TABLE IF NOT EXISTS preferences (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				data TEXT NOT NULL DEFAULT '[]'
			);

			-- Initialize with empty preferences array if not exists
			INSERT OR IGNORE INTO preferences (id, data) VALUES (1, '[]');

			-- Passkey credentials (WebAuthn)
			CREATE TABLE IF NOT EXISTS passkeys (
				credential_id TEXT PRIMARY KEY,
				public_key BLOB NOT NULL,
				counter INTEGER NOT NULL DEFAULT 0,
				name TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				last_used_at TEXT
			);

			-- Passkey registration tokens (short-lived, 10 min TTL)
			CREATE TABLE IF NOT EXISTS passkey_tokens (
				token TEXT PRIMARY KEY,
				challenge TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				name TEXT
			);

			-- App passwords (AT Protocol com.atproto.server.createAppPassword)
			CREATE TABLE IF NOT EXISTS app_passwords (
				name TEXT PRIMARY KEY,
				password_hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}

	/**
	 * Get user preferences.
	 */
	async getPreferences(): Promise<unknown[]> {
		const rows = this.sql
			.exec("SELECT data FROM preferences WHERE id = 1")
			.toArray();
		if (rows.length === 0 || !rows[0]?.data) {
			return [];
		}
		const data = rows[0]!.data as string;
		try {
			return JSON.parse(data);
		} catch {
			return [];
		}
	}

	/**
	 * Update user preferences.
	 */
	async putPreferences(preferences: unknown[]): Promise<void> {
		const data = JSON.stringify(preferences);
		this.sql.exec("UPDATE preferences SET data = ? WHERE id = 1", data);
	}

	/**
	 * Get the stored email address.
	 */
	getEmail(): string | null {
		const rows = this.sql
			.exec("SELECT email FROM repo_state WHERE id = 1")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.email as string) ?? null) : null;
	}

	/**
	 * Set the email address.
	 */
	setEmail(email: string): void {
		this.sql.exec("UPDATE repo_state SET email = ? WHERE id = 1", email);
	}

	// ============================================
	// Passkey Methods
	// ============================================

	/**
	 * Save a passkey credential.
	 */
	savePasskey(
		credentialId: string,
		publicKey: Uint8Array,
		counter: number,
		name?: string,
	): void {
		this.sql.exec(
			`INSERT INTO passkeys (credential_id, public_key, counter, name)
			 VALUES (?, ?, ?, ?)`,
			credentialId,
			publicKey,
			counter,
			name ?? null,
		);
	}

	/**
	 * Get a passkey by credential ID.
	 */
	getPasskey(credentialId: string): {
		credentialId: string;
		publicKey: Uint8Array;
		counter: number;
		name: string | null;
		createdAt: string;
		lastUsedAt: string | null;
	} | null {
		const rows = this.sql
			.exec(
				`SELECT credential_id, public_key, counter, name, created_at, last_used_at
				 FROM passkeys WHERE credential_id = ?`,
				credentialId,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		return {
			credentialId: row.credential_id as string,
			publicKey: new Uint8Array(row.public_key as ArrayBuffer),
			counter: row.counter as number,
			name: row.name as string | null,
			createdAt: row.created_at as string,
			lastUsedAt: row.last_used_at as string | null,
		};
	}

	/**
	 * List all passkeys.
	 */
	listPasskeys(): Array<{
		credentialId: string;
		name: string | null;
		createdAt: string;
		lastUsedAt: string | null;
	}> {
		const rows = this.sql
			.exec(
				`SELECT credential_id, name, created_at, last_used_at
				 FROM passkeys ORDER BY created_at DESC`,
			)
			.toArray();

		return rows.map((row) => ({
			credentialId: row.credential_id as string,
			name: row.name as string | null,
			createdAt: row.created_at as string,
			lastUsedAt: row.last_used_at as string | null,
		}));
	}

	/**
	 * Delete a passkey.
	 */
	deletePasskey(credentialId: string): boolean {
		const before = this.sql.exec("SELECT COUNT(*) as c FROM passkeys").one();
		this.sql.exec("DELETE FROM passkeys WHERE credential_id = ?", credentialId);
		const after = this.sql.exec("SELECT COUNT(*) as c FROM passkeys").one();
		return (before.c as number) > (after.c as number);
	}

	/**
	 * Update passkey counter after successful authentication.
	 */
	updatePasskeyCounter(credentialId: string, counter: number): void {
		this.sql.exec(
			`UPDATE passkeys SET counter = ?, last_used_at = datetime('now')
			 WHERE credential_id = ?`,
			counter,
			credentialId,
		);
	}

	/**
	 * Check if any passkeys exist (for conditional UI).
	 */
	hasPasskeys(): boolean {
		const result = this.sql.exec("SELECT COUNT(*) as c FROM passkeys").one();
		return (result.c as number) > 0;
	}

	// ============================================
	// Passkey Registration Token Methods
	// ============================================

	/**
	 * Save a registration token with challenge and optional name.
	 */
	savePasskeyToken(
		token: string,
		challenge: string,
		expiresAt: number,
		name?: string,
	): void {
		this.sql.exec(
			`INSERT INTO passkey_tokens (token, challenge, expires_at, name) VALUES (?, ?, ?, ?)`,
			token,
			challenge,
			expiresAt,
			name ?? null,
		);
	}

	/**
	 * Get and consume a registration token.
	 */
	consumePasskeyToken(
		token: string,
	): { challenge: string; name: string | null } | null {
		const rows = this.sql
			.exec(
				`SELECT challenge, expires_at, name FROM passkey_tokens WHERE token = ?`,
				token,
			)
			.toArray();

		if (rows.length === 0) return null;

		const row = rows[0]!;
		const expiresAt = row.expires_at as number;

		// Delete the token (single-use)
		this.sql.exec("DELETE FROM passkey_tokens WHERE token = ?", token);

		// Check if expired
		if (Date.now() > expiresAt) return null;

		return {
			challenge: row.challenge as string,
			name: (row.name as string) ?? null,
		};
	}

	/**
	 * Clean up expired tokens.
	 */
	cleanupPasskeyTokens(): void {
		this.sql.exec(
			"DELETE FROM passkey_tokens WHERE expires_at < ?",
			Date.now(),
		);
	}

	// ============================================
	// App Password Methods
	// ============================================

	/**
	 * Save an app password (store bcrypt hash, not plaintext).
	 */
	saveAppPassword(name: string, passwordHash: string): void {
		this.sql.exec(
			`INSERT INTO app_passwords (name, password_hash) VALUES (?, ?)`,
			name,
			passwordHash,
		);
	}

	/**
	 * List all app passwords (names and creation dates only — never return hashes).
	 */
	listAppPasswords(): Array<{
		name: string;
		createdAt: string;
	}> {
		const rows = this.sql
			.exec(
				`SELECT name, created_at FROM app_passwords ORDER BY created_at DESC`,
			)
			.toArray();

		return rows.map((row) => ({
			name: row.name as string,
			createdAt: sqliteDatetimeToIso(row.created_at as string),
		}));
	}

	/**
	 * Delete an app password by name.
	 */
	deleteAppPassword(name: string): boolean {
		const before = this.sql
			.exec("SELECT COUNT(*) as c FROM app_passwords")
			.one();
		this.sql.exec("DELETE FROM app_passwords WHERE name = ?", name);
		const after = this.sql
			.exec("SELECT COUNT(*) as c FROM app_passwords")
			.one();
		return (before.c as number) > (after.c as number);
	}

	/**
	 * Get all app password hashes for verification during login.
	 */
	getAppPasswordHashes(): Array<{ name: string; passwordHash: string }> {
		const rows = this.sql
			.exec(`SELECT name, password_hash FROM app_passwords`)
			.toArray();

		return rows.map((row) => ({
			name: row.name as string,
			passwordHash: row.password_hash as string,
		}));
	}
}
