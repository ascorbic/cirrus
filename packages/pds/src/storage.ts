import { CID } from "@atproto/lex-data";
import { BlockMap, type CommitData } from "@atproto/repo";
import { ReadableBlockstore, type RepoStorage } from "@atproto/repo";

/**
 * SQLite-backed repository storage for Cloudflare Durable Objects.
 *
 * Implements the RepoStorage interface from @atproto/repo, storing blocks
 * in a SQLite database within a Durable Object.
 */
export class SqliteRepoStorage
	extends ReadableBlockstore
	implements RepoStorage
{
	constructor(private sql: SqlStorage) {
		super();
	}

	/**
	 * Initialize the database schema. Should be called once on DO startup.
	 * @param initialActive - Whether the account should start in active state (default true)
	 */
	initSchema(initialActive: boolean = true): void {
		this.sql.exec(`
			-- Block storage (MST nodes + record blocks)
			CREATE TABLE IF NOT EXISTS blocks (
				cid TEXT PRIMARY KEY,
				bytes BLOB NOT NULL,
				rev TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_blocks_rev ON blocks(rev);

			-- Repo state (single row)
			CREATE TABLE IF NOT EXISTS repo_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				root_cid TEXT,
				rev TEXT,
				seq INTEGER NOT NULL DEFAULT 0,
				active INTEGER NOT NULL DEFAULT 1,
				email TEXT
			);

			-- Initialize with empty state if not exists
			INSERT OR IGNORE INTO repo_state (id, root_cid, rev, seq, active)
			VALUES (1, NULL, NULL, 0, ${initialActive ? 1 : 0});

			-- Firehose events (sequenced commit log)
			CREATE TABLE IF NOT EXISTS firehose_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,
				payload BLOB NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_firehose_created_at ON firehose_events(created_at);

			-- User preferences (single row, stores JSON array)
			CREATE TABLE IF NOT EXISTS preferences (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				data TEXT NOT NULL DEFAULT '[]'
			);

			-- Initialize with empty preferences array if not exists
			INSERT OR IGNORE INTO preferences (id, data) VALUES (1, '[]');

			-- Track blob references in records (populated during importRepo)
			CREATE TABLE IF NOT EXISTS record_blob (
				recordUri TEXT NOT NULL,
				blobCid TEXT NOT NULL,
				PRIMARY KEY (recordUri, blobCid)
			);

			CREATE INDEX IF NOT EXISTS idx_record_blob_cid ON record_blob(blobCid);

			-- Track successfully imported blobs (populated during uploadBlob)
			CREATE TABLE IF NOT EXISTS imported_blobs (
				cid TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				mimeType TEXT,
				createdAt TEXT NOT NULL DEFAULT (datetime('now'))
			);

			-- Collection name cache (for describeRepo)
			CREATE TABLE IF NOT EXISTS collections (
				collection TEXT PRIMARY KEY
			);

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
		`);

		// Migration: add email column for existing databases
		try {
			this.sql.exec("ALTER TABLE repo_state ADD COLUMN email TEXT");
		} catch {
			// Column already exists
		}
	}

	/**
	 * Get the current root CID of the repository.
	 */
	async getRoot(): Promise<CID | null> {
		const rows = this.sql
			.exec("SELECT root_cid FROM repo_state WHERE id = 1")
			.toArray();
		if (rows.length === 0 || !rows[0]?.root_cid) {
			return null;
		}
		return CID.parse(rows[0]!.root_cid as string);
	}

	/**
	 * Get the current revision string.
	 */
	async getRev(): Promise<string | null> {
		const rows = this.sql
			.exec("SELECT rev FROM repo_state WHERE id = 1")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.rev as string) ?? null) : null;
	}

	/**
	 * Get the current sequence number for firehose events.
	 */
	async getSeq(): Promise<number> {
		const rows = this.sql
			.exec("SELECT seq FROM repo_state WHERE id = 1")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.seq as number) ?? 0) : 0;
	}

	/**
	 * Increment and return the next sequence number.
	 */
	async nextSeq(): Promise<number> {
		this.sql.exec("UPDATE repo_state SET seq = seq + 1 WHERE id = 1");
		return this.getSeq();
	}

	/**
	 * Get the raw bytes for a block by CID.
	 */
	async getBytes(cid: CID): Promise<Uint8Array | null> {
		const rows = this.sql
			.exec("SELECT bytes FROM blocks WHERE cid = ?", cid.toString())
			.toArray();
		if (rows.length === 0 || !rows[0]?.bytes) {
			return null;
		}
		// SQLite returns ArrayBuffer, convert to Uint8Array
		return new Uint8Array(rows[0]!.bytes as ArrayBuffer);
	}

	/**
	 * Check if a block exists.
	 */
	async has(cid: CID): Promise<boolean> {
		const rows = this.sql
			.exec("SELECT 1 FROM blocks WHERE cid = ? LIMIT 1", cid.toString())
			.toArray();
		return rows.length > 0;
	}

	/**
	 * Get multiple blocks at once.
	 */
	async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
		const blocks = new BlockMap();
		const missing: CID[] = [];

		for (const cid of cids) {
			const bytes = await this.getBytes(cid);
			if (bytes) {
				blocks.set(cid, bytes);
			} else {
				missing.push(cid);
			}
		}

		return { blocks, missing };
	}

	/**
	 * Store a single block.
	 */
	async putBlock(cid: CID, block: Uint8Array, rev: string): Promise<void> {
		this.sql.exec(
			"INSERT OR REPLACE INTO blocks (cid, bytes, rev) VALUES (?, ?, ?)",
			cid.toString(),
			block,
			rev,
		);
	}

	/**
	 * Store multiple blocks at once.
	 */
	async putMany(blocks: BlockMap, rev: string): Promise<void> {
		// Access BlockMap's internal map to avoid iterator issues in Workers environment
		// BlockMap stores data in a Map<string, Uint8Array> internally as 'map' (private field)
		const internalMap = (blocks as unknown as { map: Map<string, Uint8Array> })
			.map;
		if (internalMap) {
			for (const [cidStr, bytes] of internalMap) {
				this.sql.exec(
					"INSERT OR REPLACE INTO blocks (cid, bytes, rev) VALUES (?, ?, ?)",
					cidStr,
					bytes,
					rev,
				);
			}
		}
	}

	/**
	 * Update the repository root.
	 */
	async updateRoot(cid: CID, rev: string): Promise<void> {
		this.sql.exec(
			"UPDATE repo_state SET root_cid = ?, rev = ? WHERE id = 1",
			cid.toString(),
			rev,
		);
	}

	/**
	 * Apply a commit atomically: add new blocks, remove old blocks, update root.
	 */
	async applyCommit(commit: CommitData): Promise<void> {
		// Note: Durable Object SQLite doesn't support BEGIN/COMMIT,
		// but operations within a single DO request are already atomic.

		// Access BlockMap's internal map to avoid iterator issues in Workers environment
		const internalMap = (
			commit.newBlocks as unknown as { map: Map<string, Uint8Array> }
		).map;
		if (internalMap) {
			for (const [cidStr, bytes] of internalMap) {
				this.sql.exec(
					"INSERT OR REPLACE INTO blocks (cid, bytes, rev) VALUES (?, ?, ?)",
					cidStr,
					bytes,
					commit.rev,
				);
			}
		}

		// Remove old blocks - access CidSet's internal set to avoid CID.parse shim issues
		const removedSet = (commit.removedCids as unknown as { set: Set<string> })
			.set;
		if (removedSet) {
			for (const cidStr of removedSet) {
				this.sql.exec("DELETE FROM blocks WHERE cid = ?", cidStr);
			}
		}

		// Update root
		await this.updateRoot(commit.cid, commit.rev);
	}

	/**
	 * Get total storage size in bytes.
	 */
	async sizeInBytes(): Promise<number> {
		const rows = this.sql
			.exec("SELECT SUM(LENGTH(bytes)) as total FROM blocks")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.total as number) ?? 0) : 0;
	}

	/**
	 * Clear all data (for testing).
	 */
	async destroy(): Promise<void> {
		this.sql.exec("DELETE FROM blocks");
		this.sql.exec(
			"UPDATE repo_state SET root_cid = NULL, rev = NULL WHERE id = 1",
		);
	}

	/**
	 * Count the number of blocks stored.
	 */
	async countBlocks(): Promise<number> {
		const rows = this.sql
			.exec("SELECT COUNT(*) as count FROM blocks")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.count as number) ?? 0) : 0;
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
	 * Get the activation state of the account.
	 */
	async getActive(): Promise<boolean> {
		const rows = this.sql
			.exec("SELECT active FROM repo_state WHERE id = 1")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.active as number) === 1) : true;
	}

	/**
	 * Set the activation state of the account.
	 */
	async setActive(active: boolean): Promise<void> {
		this.sql.exec(
			"UPDATE repo_state SET active = ? WHERE id = 1",
			active ? 1 : 0,
		);
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
	// Collection Cache Methods
	// ============================================

	/**
	 * Get all cached collection names.
	 */
	getCollections(): string[] {
		const rows = this.sql
			.exec("SELECT collection FROM collections ORDER BY collection")
			.toArray();
		return rows.map((row) => row.collection as string);
	}

	/**
	 * Add a collection name to the cache (no-op if already present).
	 */
	addCollection(collection: string): void {
		this.sql.exec(
			"INSERT OR IGNORE INTO collections (collection) VALUES (?)",
			collection,
		);
	}

	/**
	 * Check if the collections cache has been populated.
	 */
	hasCollections(): boolean {
		const rows = this.sql
			.exec("SELECT 1 FROM collections LIMIT 1")
			.toArray();
		return rows.length > 0;
	}

	// ============================================
	// Blob Tracking Methods
	// ============================================

	/**
	 * Add a blob reference from a record.
	 */
	addRecordBlob(recordUri: string, blobCid: string): void {
		this.sql.exec(
			"INSERT OR IGNORE INTO record_blob (recordUri, blobCid) VALUES (?, ?)",
			recordUri,
			blobCid,
		);
	}

	/**
	 * Add multiple blob references from a record.
	 */
	addRecordBlobs(recordUri: string, blobCids: string[]): void {
		for (const cid of blobCids) {
			this.addRecordBlob(recordUri, cid);
		}
	}

	/**
	 * Remove all blob references for a record.
	 */
	removeRecordBlobs(recordUri: string): void {
		this.sql.exec("DELETE FROM record_blob WHERE recordUri = ?", recordUri);
	}

	/**
	 * Track an imported blob.
	 */
	trackImportedBlob(cid: string, size: number, mimeType: string): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO imported_blobs (cid, size, mimeType) VALUES (?, ?, ?)",
			cid,
			size,
			mimeType,
		);
	}

	/**
	 * Check if a blob has been imported.
	 */
	isBlobImported(cid: string): boolean {
		const rows = this.sql
			.exec("SELECT 1 FROM imported_blobs WHERE cid = ? LIMIT 1", cid)
			.toArray();
		return rows.length > 0;
	}

	/**
	 * Count expected blobs (distinct blobs referenced by records).
	 */
	countExpectedBlobs(): number {
		const rows = this.sql
			.exec("SELECT COUNT(DISTINCT blobCid) as count FROM record_blob")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.count as number) ?? 0) : 0;
	}

	/**
	 * Count imported blobs.
	 */
	countImportedBlobs(): number {
		const rows = this.sql
			.exec("SELECT COUNT(*) as count FROM imported_blobs")
			.toArray();
		return rows.length > 0 ? ((rows[0]!.count as number) ?? 0) : 0;
	}

	/**
	 * List blobs that are referenced but not yet imported.
	 */
	listMissingBlobs(
		limit: number = 500,
		cursor?: string,
	): { blobs: Array<{ cid: string; recordUri: string }>; cursor?: string } {
		const blobs: Array<{ cid: string; recordUri: string }> = [];

		// Get blobs referenced but not in imported_blobs
		const query = cursor
			? `SELECT rb.blobCid, rb.recordUri FROM record_blob rb
				 LEFT JOIN imported_blobs ib ON rb.blobCid = ib.cid
				 WHERE ib.cid IS NULL AND rb.blobCid > ?
				 ORDER BY rb.blobCid
				 LIMIT ?`
			: `SELECT rb.blobCid, rb.recordUri FROM record_blob rb
				 LEFT JOIN imported_blobs ib ON rb.blobCid = ib.cid
				 WHERE ib.cid IS NULL
				 ORDER BY rb.blobCid
				 LIMIT ?`;

		const rows = cursor
			? this.sql.exec(query, cursor, limit + 1).toArray()
			: this.sql.exec(query, limit + 1).toArray();

		for (const row of rows.slice(0, limit)) {
			blobs.push({
				cid: row.blobCid as string,
				recordUri: row.recordUri as string,
			});
		}

		const hasMore = rows.length > limit;
		const nextCursor = hasMore ? blobs[blobs.length - 1]?.cid : undefined;

		return { blobs, cursor: nextCursor };
	}

	/**
	 * Clear all blob tracking data (for testing).
	 */
	clearBlobTracking(): void {
		this.sql.exec("DELETE FROM record_blob");
		this.sql.exec("DELETE FROM imported_blobs");
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
	savePasskeyToken(token: string, challenge: string, expiresAt: number, name?: string): void {
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
	consumePasskeyToken(token: string): { challenge: string; name: string | null } | null {
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

		return { challenge: row.challenge as string, name: (row.name as string) ?? null };
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
}
