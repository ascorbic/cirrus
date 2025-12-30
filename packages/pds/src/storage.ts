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
	 */
	initSchema(): void {
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
				seq INTEGER NOT NULL DEFAULT 0
			);

			-- Initialize with empty state if not exists
			INSERT OR IGNORE INTO repo_state (id, root_cid, rev, seq)
			VALUES (1, NULL, NULL, 0);

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
		`);
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
}
