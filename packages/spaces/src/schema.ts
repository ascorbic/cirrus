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

/**
 * Bump on any breaking change to the tables below.
 *
 * 2: baseline policies replace simplespace config; members carry
 *    read/write access; writers carry space revisions; revoked
 *    credentials; coalescing notification queue.
 */
export const SPACE_SCHEMA_VERSION = 2;

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

	-- Authority role only. The policy is stored as its normalised lexicon
	-- object (com.atproto.{personal,member,managed}space.policy).
	CREATE TABLE IF NOT EXISTS config (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		policy TEXT NOT NULL
	);

	-- memberspace member list.
	CREATE TABLE IF NOT EXISTS member (
		did TEXT PRIMARY KEY,
		can_read INTEGER NOT NULL,
		can_write INTEGER NOT NULL
	);

	-- The writer set, sequenced by space revision.
	CREATE TABLE IF NOT EXISTS writer (
		did TEXT PRIMARY KEY,
		repo_rev TEXT NOT NULL,
		data BLOB NOT NULL,
		space_rev TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_writer_space_rev ON writer(space_rev);

	CREATE TABLE IF NOT EXISTS notify_registration (
		service TEXT PRIMARY KEY,
		endpoint TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);

	-- Outbound notifications, both roles. A row with a coalesce_key is
	-- replaced by a newer one with the same key; deadline (ms) is when
	-- retrying stops.
	CREATE TABLE IF NOT EXISTS notify_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		service TEXT NOT NULL,
		body TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL,
		deadline INTEGER,
		coalesce_key TEXT UNIQUE
	);
	CREATE INDEX IF NOT EXISTS idx_notify_queue_next ON notify_queue(next_at);

	-- Credentials for this space revoked by its authority (repo-host role).
	CREATE TABLE IF NOT EXISTS revoked_credential (
		jti TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	);

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
/**
 * Give up delivering a notification without its own deadline after this
 * many attempts: syncer fan-out is reasonable-effort, and a syncer that
 * misses one recovers through listRepos.
 */
export const NOTIFY_MAX_ATTEMPTS = 5;
/** A repo host retries its write notification to the authority this long. */
export const NOTIFY_WRITE_RETRY_MS = 24 * 60 * 60 * 1000;
/** Cap on the backoff between notification retries. */
export const NOTIFY_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** notifyWrite refuses repo revisions this far ahead of the clock. */
export const MAX_REV_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The largest record a space repo accepts, as its DRISL encoding. */
export const MAX_SPACE_RECORD_BYTES = 1024 * 1024;
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

	-- Blobs referenced by an imported space repo that had not been uploaded
	-- yet. uploadBlob claims them and promotes the staged copy into each
	-- space's blob prefix.
	CREATE TABLE IF NOT EXISTS pending_blob (
		cid TEXT NOT NULL,
		uri TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (cid, uri)
	);
`;

/** Forget pending imported-space blobs that were never uploaded. */
export const PENDING_BLOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Remove `pending` index entries that never activated after this long. */
export const PENDING_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
