/**
 * SQLite schema for SpaceDurableObject.
 *
 * Mirrors the reference PDS's `002-space` migration table for table, minus
 * the `space` column on every row — one DO per space makes it redundant.
 *
 * There is no migration path between alpha schema versions: bumping
 * {@link SPACE_SCHEMA_VERSION} puts existing DOs into a refusing state until
 * `pds spaces reset` wipes them. That is the alpha policy, applied honestly.
 */

/** Bump on any breaking change to the tables below. */
export const SPACE_SCHEMA_VERSION = 1;

export const SPACE_DO_SCHEMA = `
	-- One row. schema_version is checked on every open.
	CREATE TABLE IF NOT EXISTS meta (
		uri TEXT NOT NULL,
		authority TEXT NOT NULL,
		type TEXT NOT NULL,
		skey TEXT NOT NULL,
		is_authority INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		deleted_at TEXT,
		schema_version INTEGER NOT NULL
	);

	-- Operator's permissioned repo in this space.
	CREATE TABLE IF NOT EXISTS record (
		collection TEXT NOT NULL,
		rkey TEXT NOT NULL,
		cid TEXT NOT NULL,
		bytes BLOB NOT NULL,
		rev TEXT NOT NULL,
		indexed_at TEXT NOT NULL,
		PRIMARY KEY (collection, rkey)
	);
	CREATE INDEX IF NOT EXISTS idx_record_rev ON record(rev);

	CREATE TABLE IF NOT EXISTS record_blob (
		blob_cid TEXT NOT NULL,
		collection TEXT NOT NULL,
		rkey TEXT NOT NULL,
		PRIMARY KEY (blob_cid, collection, rkey)
	);
	CREATE INDEX IF NOT EXISTS idx_record_blob_record ON record_blob(collection, rkey);

	CREATE TABLE IF NOT EXISTS repo_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		set_hash BLOB NOT NULL,
		rev TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS oplog (
		rev TEXT NOT NULL,
		idx INTEGER NOT NULL,
		collection TEXT NOT NULL,
		rkey TEXT NOT NULL,
		cid TEXT,
		prev TEXT,
		PRIMARY KEY (rev, idx)
	);

	-- Authority role only.
	CREATE TABLE IF NOT EXISTS config (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		policy TEXT NOT NULL,
		managing_app TEXT,
		app_access TEXT NOT NULL,
		app_allowed TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS member (did TEXT PRIMARY KEY);

	CREATE TABLE IF NOT EXISTS writer (
		did TEXT PRIMARY KEY,
		rev TEXT NOT NULL,
		hash BLOB NOT NULL
	);

	CREATE TABLE IF NOT EXISTS notify_registration (
		service TEXT PRIMARY KEY,
		endpoint TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS notify_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		service TEXT NOT NULL,
		body TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_notify_queue_next ON notify_queue(next_at);

	-- Replay protection, both roles.
	CREATE TABLE IF NOT EXISTS replay (
		kind TEXT NOT NULL,
		key TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		PRIMARY KEY (kind, key)
	);
`;

/** Retain oplog entries for at most this many days. */
export const OPLOG_RETENTION_DAYS = 30;
/** Retain at most this many oplog entries. */
export const OPLOG_RETENTION_OPS = 10_000;
/** Notify registrations expire after this many days. */
export const NOTIFY_REGISTRATION_DAYS = 7;
/** Give up delivering a notification after this many attempts. */
export const NOTIFY_MAX_ATTEMPTS = 5;
/** Base delay for notification retry backoff, in milliseconds. */
export const NOTIFY_BACKOFF_BASE_MS = 30_000;

export const INDEX_DO_SCHEMA = `
	CREATE TABLE IF NOT EXISTS space (
		uri TEXT PRIMARY KEY,
		authority TEXT NOT NULL,
		type TEXT NOT NULL,
		skey TEXT NOT NULL,
		is_authority INTEGER NOT NULL,
		state TEXT NOT NULL,             -- 'pending' | 'active' | 'deleted'
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		schema_version INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_space_state ON space(state);
`;

/** Remove `pending` index entries that never activated after this long. */
export const PENDING_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
