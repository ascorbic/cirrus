/**
 * SpaceDurableObject – one instance per space, addressed by
 * `idFromName(spaceUri)`.
 *
 * Holds everything Cirrus knows about that space: the operator's
 * permissioned repo (records, oplog, LtHash state, blob references) and,
 * when the operator is the authority, the space's policy, member list,
 * writer set (sequenced by space revision) and notification registrations.
 * Both roles share the outbound notification queue, and the replay and
 * revocation tables for tokens presented against the space.
 *
 * Constraints inherited from the Cirrus architecture:
 * - No R2 I/O in here, ever. Blobs are the Worker's job.
 * - No key material in here except through
 *   {@link SpaceHostConfig.getKeypair}, used only for outbound notification
 *   service JWTs from the alarm. Commits are unsigned and MACs are the
 *   Worker's, so the KEM key never enters this class.
 * - The host supplies its identity via {@link getHostConfig}; this class
 *   must not read `env.DID`. If it ever contains a branch on which host is
 *   running it, the boundary has failed.
 */

import { DurableObject } from "cloudflare:workers";
import { RepoCommit } from "@atproto/space";
import { SpaceError } from "./errors.js";
import {
	MEMBER_COLLECTION,
	POLICY_COLLECTION,
	POLICY_RKEY,
	areMembersPublished,
	assertMemberspace,
	didToRecordKey,
	isPolicyPublished,
} from "./policy.js";
import { prepareRecord } from "./records.js";
import {
	NOTIFY_BACKOFF_BASE_MS,
	NOTIFY_BACKOFF_MAX_MS,
	NOTIFY_MAX_ATTEMPTS,
	NOTIFY_REGISTRATION_DAYS,
	OPLOG_RETENTION_DAYS,
	OPLOG_RETENTION_OPS,
	SPACE_DO_SCHEMA,
	SPACE_SCHEMA_VERSION,
} from "./schema.js";
import { nextRev, tidCutoff } from "./tid.js";
import { createServiceJwt } from "./service-jwt.js";
import type {
	ApplyWritesResult,
	ImportedRecord,
	NotifyItem,
	OplogEntry,
	PreparedSpaceWrite,
	RepoCommitResult,
	RepoState,
	SpaceHostConfig,
	SpaceMember,
	SpaceMeta,
	SpacePolicy,
	SpaceRecordRow,
	SpaceSequence,
	SpaceWriter,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Interval between maintenance passes (compaction, replay cleanup). */
const MAINTENANCE_INTERVAL_MS = DAY_MS;
/** How many queued notifications to attempt per alarm invocation. */
const NOTIFY_BATCH = 20;

interface QueueRow {
	id: number;
	service: string;
	body: string;
	attempts: number;
	next_at: number;
	deadline: number | null;
}

/** HTTP statuses worth retrying; anything else is a permanent refusal. */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

export abstract class SpaceDurableObject<
	Env = unknown,
> extends DurableObject<Env> {
	private sql: SqlStorage;
	private initialized = false;
	private outdated = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	/**
	 * Host identity and signing configuration. Implemented by the host
	 * Worker's subclass; see {@link SpaceHostConfig}.
	 */
	protected abstract getHostConfig():
		| SpaceHostConfig
		| Promise<SpaceHostConfig>;

	// ------------------------------------------------------------------
	// Initialisation and schema versioning
	// ------------------------------------------------------------------

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.initialized) return;
			const hasMeta =
				this.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
					)
					.toArray().length > 0;
			if (hasMeta) {
				const row = this.sql
					.exec("SELECT schema_version FROM meta LIMIT 1")
					.toArray()[0];
				if (row && (row.schema_version as number) !== SPACE_SCHEMA_VERSION) {
					// Alpha policy: no migrations between schema versions. The DO
					// refuses every RPC until `pds spaces reset` wipes it.
					this.outdated = true;
					this.initialized = true;
					return;
				}
			}
			this.sql.exec(SPACE_DO_SCHEMA);
			this.initialized = true;
		});
	}

	/**
	 * Gate every RPC: initialise storage and refuse when the stored schema
	 * belongs to a different alpha build.
	 */
	private async ensureOpen(): Promise<void> {
		await this.ensureInitialized();
		if (this.outdated) {
			throw new SpaceError(
				"SpacesSchemaOutdated",
				"Space data was written by an incompatible alpha build. Run `pds spaces reset` to wipe space data (the public repo is unaffected).",
			);
		}
	}

	private readMeta(): SpaceMeta | null {
		const row = this.sql.exec("SELECT * FROM meta LIMIT 1").toArray()[0];
		if (!row) return null;
		return {
			uri: row.uri as string,
			authority: row.authority as string,
			type: row.type as string,
			skey: row.skey as string,
			isAuthority: (row.is_authority as number) === 1,
			createdAt: row.created_at as string,
			deletedAt: (row.deleted_at as string | null) ?? null,
		};
	}

	/** Meta for an existing, non-deleted space, or throw. */
	private requireLiveMeta(): SpaceMeta {
		const meta = this.readMeta();
		if (!meta) {
			throw new SpaceError("SpaceNotFound", "Space is not initialised");
		}
		if (meta.deletedAt) {
			throw new SpaceError("SpaceNotFound", "Space has been deleted");
		}
		return meta;
	}

	/** The policy of a live space this host governs, or SpaceNotFound. */
	private requirePolicy(): { meta: SpaceMeta; policy: SpacePolicy } {
		const meta = this.requireLiveMeta();
		const policy = this.readPolicy();
		if (!policy) {
			throw new SpaceError("SpaceNotFound", "Space not found");
		}
		return { meta, policy };
	}

	async rpcGetMeta(): Promise<SpaceMeta | null> {
		await this.ensureOpen();
		return this.readMeta();
	}

	/**
	 * Initialise this DO as the operator's repo in a space (either role).
	 * For the authority role a policy creates the space: refused when a live
	 * space already has one. A deleted space may be created again; its
	 * tables were wiped at deletion, so reviving is a fresh start. Returns
	 * the commit when publishing the policy wrote to the repo.
	 */
	async rpcInit(params: {
		uri: string;
		authority: string;
		type: string;
		skey: string;
		isAuthority: boolean;
		policy?: SpacePolicy;
	}): Promise<RepoCommitResult | null> {
		await this.ensureOpen();
		const existing = this.readMeta();
		if (existing && existing.uri !== params.uri) {
			throw new SpaceError(
				"InvalidSpaceUri",
				`Space DO already holds ${existing.uri}`,
			);
		}
		if (existing && !existing.deletedAt && params.policy && this.readPolicy()) {
			throw new SpaceError(
				"SpaceAlreadyExists",
				`Space already exists: ${params.uri}`,
			);
		}
		const publishWrites = params.policy
			? await this.preparePolicyRecordWrites(params.policy)
			: [];
		return this.ctx.storage.transactionSync(() => {
			if (!existing) {
				this.sql.exec(
					`INSERT INTO meta (uri, authority, type, skey, is_authority, created_at, deleted_at, schema_version)
					 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
					params.uri,
					params.authority,
					params.type,
					params.skey,
					params.isAuthority ? 1 : 0,
					new Date().toISOString(),
					SPACE_SCHEMA_VERSION,
				);
			} else if (existing.deletedAt) {
				this.sql.exec(
					"UPDATE meta SET deleted_at = NULL, created_at = ?, is_authority = ?",
					new Date().toISOString(),
					params.isAuthority ? 1 : 0,
				);
			}
			if (!params.policy) return null;
			this.writePolicy(params.policy);
			return this.applyWritesSync(publishWrites);
		});
	}

	// ------------------------------------------------------------------
	// Permissioned repo: writes
	// ------------------------------------------------------------------

	async rpcApplyWrites(
		writes: PreparedSpaceWrite[],
	): Promise<ApplyWritesResult> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.ctx.storage.transactionSync(
			() => this.applyWritesSync(writes)!,
		);
	}

	/**
	 * Apply a batch as one commit sharing a single rev. Must run in a
	 * transaction. Returns null for an empty batch. Each write lands before
	 * the next is read, so a batch can create and then update a record, and
	 * a repeated create is refused rather than counted twice.
	 */
	private applyWritesSync(
		writes: PreparedSpaceWrite[],
	): ApplyWritesResult | null {
		if (writes.length === 0) return null;
		const state = this.readRepoState();
		const commit = RepoCommit.fromState(state?.setHash ?? null);
		const rev = nextRev(state?.rev ?? null);
		const indexedAt = new Date().toISOString();
		const results: ApplyWritesResult["results"] = [];
		let idx = 0;

		for (const write of writes) {
			const prevRow = this.sql
				.exec(
					"SELECT cid FROM record WHERE collection = ? AND rkey = ?",
					write.collection,
					write.rkey,
				)
				.toArray()[0];
			const prev = prevRow ? (prevRow.cid as string) : null;

			if (write.action === "create" && prev) {
				throw new SpaceError(
					"RecordAlreadyExists",
					`Record already exists: ${write.collection}/${write.rkey}`,
				);
			}
			if (write.action !== "create" && !prev) {
				throw new SpaceError(
					"RecordNotFound",
					`Record not found: ${write.collection}/${write.rkey}`,
				);
			}

			if (write.action === "delete") {
				this.deleteRecordRow(write.collection, write.rkey);
				commit.setHash.remove(`${write.collection}/${write.rkey}/${prev}`);
				this.appendOplog(rev, idx++, write.collection, write.rkey, null, prev);
				results.push({
					action: "delete",
					collection: write.collection,
					rkey: write.rkey,
					cid: null,
				});
				continue;
			}

			this.sql.exec(
				`INSERT OR REPLACE INTO record (collection, rkey, cid, bytes, rev, indexed_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				write.collection,
				write.rkey,
				write.cid,
				write.bytes,
				rev,
				indexedAt,
			);
			this.replaceRecordBlobs(write.collection, write.rkey, write.blobCids);
			if (prev) {
				commit.setHash.remove(`${write.collection}/${write.rkey}/${prev}`);
			}
			commit.setHash.add(`${write.collection}/${write.rkey}/${write.cid}`);
			this.appendOplog(
				rev,
				idx++,
				write.collection,
				write.rkey,
				write.cid,
				prev,
			);
			results.push({
				action: write.action,
				collection: write.collection,
				rkey: write.rkey,
				cid: write.cid,
			});
		}

		this.writeRepoState(commit.setHash.state(), rev);
		return { rev, data: commit.setHash.digest(), results };
	}

	private deleteRecordRow(collection: string, rkey: string): void {
		this.sql.exec(
			"DELETE FROM record WHERE collection = ? AND rkey = ?",
			collection,
			rkey,
		);
		this.sql.exec(
			"DELETE FROM record_blob WHERE collection = ? AND rkey = ?",
			collection,
			rkey,
		);
	}

	private replaceRecordBlobs(
		collection: string,
		rkey: string,
		blobCids: string[],
	): void {
		this.sql.exec(
			"DELETE FROM record_blob WHERE collection = ? AND rkey = ?",
			collection,
			rkey,
		);
		for (const blobCid of blobCids) {
			this.sql.exec(
				"INSERT OR IGNORE INTO record_blob (blob_cid, collection, rkey) VALUES (?, ?, ?)",
				blobCid,
				collection,
				rkey,
			);
		}
	}

	private writeRepoState(setHash: Uint8Array, rev: string): void {
		this.sql.exec(
			`INSERT INTO repo_state (id, set_hash, rev) VALUES (1, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET set_hash = excluded.set_hash, rev = excluded.rev`,
			setHash,
			rev,
		);
	}

	private appendOplog(
		rev: string,
		idx: number,
		collection: string,
		rkey: string,
		cid: string | null,
		prev: string | null,
	): void {
		this.sql.exec(
			"INSERT INTO oplog (rev, idx, collection, rkey, cid, prev) VALUES (?, ?, ?, ?, ?, ?)",
			rev,
			idx,
			collection,
			rkey,
			cid,
			prev,
		);
	}

	/** The collections the repo holds records in, for clearRecords' grants. */
	async rpcListCollections(): Promise<string[]> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.sql
			.exec("SELECT DISTINCT collection FROM record ORDER BY collection")
			.toArray()
			.map((row) => row.collection as string);
	}

	/**
	 * Delete every record outside `keep` and clear the oplog, leaving the
	 * repo at a new rev with the digest of what remains. Returns null when
	 * there was nothing to delete.
	 */
	async rpcClearRecords(keep: string[]): Promise<RepoCommitResult | null> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.ctx.storage.transactionSync(() => {
			const state = this.readRepoState();
			if (!state) return null;
			const placeholders = keep.map(() => "?").join(", ");
			const notKept =
				keep.length > 0 ? `collection NOT IN (${placeholders})` : "1=1";
			const doomed = this.sql
				.exec(`SELECT COUNT(*) AS n FROM record WHERE ${notKept}`, ...keep)
				.toArray()[0]?.n as number;
			if (!doomed) return null;
			this.sql.exec(`DELETE FROM record_blob WHERE ${notKept}`, ...keep);
			this.sql.exec(`DELETE FROM record WHERE ${notKept}`, ...keep);
			this.sql.exec("DELETE FROM oplog");
			const commit = new RepoCommit();
			for (const row of this.sql
				.exec("SELECT collection, rkey, cid FROM record")
				.toArray()) {
				commit.setHash.add(`${row.collection}/${row.rkey}/${row.cid}`);
			}
			const rev = nextRev(state.rev);
			this.writeRepoState(commit.setHash.state(), rev);
			return { rev, data: commit.setHash.digest() };
		});
	}

	/**
	 * Replace the repo with records imported from its previous host. Takes a
	 * new rev here and none of its history, so the oplog starts empty.
	 * Returns the digest so the Worker can confirm it matches the archive's
	 * commit.
	 */
	async rpcImportRepo(records: ImportedRecord[]): Promise<RepoCommitResult> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.ctx.storage.transactionSync(() => {
			const state = this.readRepoState();
			this.sql.exec("DELETE FROM record_blob");
			this.sql.exec("DELETE FROM record");
			this.sql.exec("DELETE FROM oplog");
			const rev = nextRev(state?.rev ?? null);
			const indexedAt = new Date().toISOString();
			const commit = new RepoCommit();
			for (const record of records) {
				this.sql.exec(
					`INSERT INTO record (collection, rkey, cid, bytes, rev, indexed_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					record.collection,
					record.rkey,
					record.cid,
					record.bytes,
					rev,
					indexedAt,
				);
				this.replaceRecordBlobs(
					record.collection,
					record.rkey,
					record.blobCids,
				);
				commit.setHash.add(`${record.collection}/${record.rkey}/${record.cid}`);
			}
			this.writeRepoState(commit.setHash.state(), rev);
			return { rev, data: commit.setHash.digest() };
		});
	}

	// ------------------------------------------------------------------
	// Permissioned repo: reads
	// ------------------------------------------------------------------

	private readRepoState(): RepoState | null {
		const row = this.sql
			.exec("SELECT set_hash, rev FROM repo_state WHERE id = 1")
			.toArray()[0];
		if (!row) return null;
		return {
			setHash: new Uint8Array(row.set_hash as ArrayBuffer),
			rev: row.rev as string,
		};
	}

	async rpcGetRecord(
		collection: string,
		rkey: string,
	): Promise<{ cid: string; bytes: Uint8Array } | null> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const row = this.sql
			.exec(
				"SELECT cid, bytes FROM record WHERE collection = ? AND rkey = ?",
				collection,
				rkey,
			)
			.toArray()[0];
		if (!row) return null;
		return {
			cid: row.cid as string,
			bytes: new Uint8Array(row.bytes as ArrayBuffer),
		};
	}

	/**
	 * List records ordered by (collection, rkey) — equivalent to record-URI
	 * order since every record shares the space and repo prefix. Descending
	 * by default, matching the reference; `reverse` flips to ascending.
	 */
	async rpcListRecords(params: {
		collection?: string;
		limit: number;
		after?: { collection: string; rkey: string };
		reverse?: boolean;
		excludeValues?: boolean;
	}): Promise<{ records: SpaceRecordRow[]; hasMore: boolean }> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const asc = params.reverse === true;
		const op = asc ? ">" : "<";
		const order = asc ? "ASC" : "DESC";
		const args: unknown[] = [];
		let where = "1=1";
		if (params.collection) {
			where += " AND collection = ?";
			args.push(params.collection);
		}
		if (params.after) {
			where += ` AND (collection ${op} ? OR (collection = ? AND rkey ${op} ?))`;
			args.push(
				params.after.collection,
				params.after.collection,
				params.after.rkey,
			);
		}
		const rows = this.sql
			.exec(
				`SELECT collection, rkey, cid${params.excludeValues ? "" : ", bytes"} FROM record
				 WHERE ${where}
				 ORDER BY collection ${order}, rkey ${order}
				 LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return {
			records: page.map((row) => ({
				collection: row.collection as string,
				rkey: row.rkey as string,
				cid: row.cid as string,
				...(params.excludeValues
					? {}
					: { bytes: new Uint8Array(row.bytes as ArrayBuffer) }),
			})),
			hasMore,
		};
	}

	/**
	 * Records in strict byte order of their `{collection}/{rkey}` path, as a
	 * repo archive requires — not (collection, rkey) order, which differs
	 * when one collection NSID prefixes another. `state` is the repo state
	 * the page was read at: the page and the state are one snapshot
	 * (synchronous reads, single-threaded DO), so a streaming export can
	 * fence against concurrent writes.
	 */
	async rpcListRecordsByPath(params: {
		afterPath?: string;
		limit: number;
	}): Promise<{
		records: Array<{ collection: string; rkey: string; bytes: Uint8Array }>;
		hasMore: boolean;
		state: RepoState | null;
	}> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const state = this.readRepoState();
		// SQLite's default BINARY collation compares UTF-8 bytes, which is
		// the archive's order.
		const rows = this.sql
			.exec(
				`SELECT collection, rkey, bytes FROM record
				 ${params.afterPath !== undefined ? "WHERE collection || '/' || rkey > ?" : ""}
				 ORDER BY collection || '/' || rkey ASC
				 LIMIT ?`,
				...(params.afterPath !== undefined ? [params.afterPath] : []),
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return {
			records: page.map((row) => ({
				collection: row.collection as string,
				rkey: row.rkey as string,
				bytes: new Uint8Array(row.bytes as ArrayBuffer),
			})),
			hasMore,
			state,
		};
	}

	async rpcGetRepoState(): Promise<RepoState | null> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.readRepoState();
	}

	/**
	 * List oplog entries after `since` (a rev) or `after` (an exact cursor
	 * position). Creates and updates carry the record's current bytes when
	 * the oplog cid still matches the live record; superseded values are
	 * omitted. When the page reaches the head, `head` carries the repo
	 * state read in the same transaction so the Worker can attach the
	 * commit without a state race.
	 */
	async rpcListRepoOps(params: {
		since?: string;
		after?: { rev: string; idx: number };
		limit: number;
		excludeValues?: boolean;
	}): Promise<{ ops: OplogEntry[]; head?: RepoState }> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return this.ctx.storage.transactionSync(() => {
			const args: unknown[] = [];
			let where = "1=1";
			if (params.after) {
				where += " AND (o.rev > ? OR (o.rev = ? AND o.idx > ?))";
				args.push(params.after.rev, params.after.rev, params.after.idx);
			} else if (params.since) {
				where += " AND o.rev > ?";
				args.push(params.since);
			}
			const values = params.excludeValues ? "" : ", r.bytes AS live_bytes";
			const rows = this.sql
				.exec(
					`SELECT o.rev, o.idx, o.collection, o.rkey, o.cid, o.prev${values}
					 FROM oplog o
					 ${params.excludeValues ? "" : "LEFT JOIN record r ON r.collection = o.collection AND r.rkey = o.rkey AND r.cid = o.cid"}
					 WHERE ${where}
					 ORDER BY o.rev ASC, o.idx ASC
					 LIMIT ?`,
					...args,
					params.limit + 1,
				)
				.toArray();
			const hasMore = rows.length > params.limit;
			const page = hasMore ? rows.slice(0, params.limit) : rows;
			const ops: OplogEntry[] = page.map((row) => ({
				rev: row.rev as string,
				idx: row.idx as number,
				collection: row.collection as string,
				rkey: row.rkey as string,
				cid: (row.cid as string | null) ?? null,
				prev: (row.prev as string | null) ?? null,
				...(row.live_bytes
					? { bytes: new Uint8Array(row.live_bytes as ArrayBuffer) }
					: {}),
			}));
			if (hasMore) return { ops };
			const head = this.readRepoState();
			return { ops, ...(head ? { head } : {}) };
		});
	}

	/** Distinct blob CIDs referenced by records, ascending, paged. */
	async rpcListBlobs(params: {
		since?: string;
		limit: number;
		afterCid?: string;
	}): Promise<{ cids: string[]; hasMore: boolean }> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const args: unknown[] = [];
		let where = "1=1";
		if (params.since) {
			where += " AND r.rev > ?";
			args.push(params.since);
		}
		if (params.afterCid) {
			where += " AND b.blob_cid > ?";
			args.push(params.afterCid);
		}
		const rows = this.sql
			.exec(
				`SELECT DISTINCT b.blob_cid FROM record_blob b
				 JOIN record r ON r.collection = b.collection AND r.rkey = b.rkey
				 WHERE ${where}
				 ORDER BY b.blob_cid ASC
				 LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return { cids: page.map((r) => r.blob_cid as string), hasMore };
	}

	/** Whether a blob CID is referenced by any record in this space. */
	async rpcHasSpaceBlob(cid: string): Promise<boolean> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return (
			this.sql
				.exec("SELECT 1 FROM record_blob WHERE blob_cid = ? LIMIT 1", cid)
				.toArray().length > 0
		);
	}

	// ------------------------------------------------------------------
	// Replay protection and revocation
	// ------------------------------------------------------------------

	/**
	 * Record a single-use key. Returns true when the key was fresh (now
	 * recorded), false when it was already seen and must be refused.
	 */
	async rpcCheckReplay(
		kind: string,
		key: string,
		expiresAtSec: number,
	): Promise<boolean> {
		await this.ensureOpen();
		const result = this.sql.exec(
			"INSERT OR IGNORE INTO replay (kind, key, expires_at) VALUES (?, ?, ?)",
			kind,
			key,
			expiresAtSec,
		);
		return result.rowsWritten > 0;
	}

	/**
	 * Record credentials the authority revoked (repo-host role). Held until
	 * any credential with that jti must have expired anyway. Needs no live
	 * repo: a revocation can precede the first write.
	 */
	async rpcRevokeCredentials(
		jtis: string[],
		expiresAtSec: number,
	): Promise<void> {
		await this.ensureOpen();
		for (const jti of jtis) {
			this.sql.exec(
				`INSERT INTO revoked_credential (jti, expires_at) VALUES (?, ?)
				 ON CONFLICT (jti) DO UPDATE SET expires_at = excluded.expires_at`,
				jti,
				expiresAtSec,
			);
		}
		await this.scheduleNextAlarm();
	}

	async rpcIsCredentialRevoked(jti: string): Promise<boolean> {
		await this.ensureOpen();
		return (
			this.sql
				.exec(
					"SELECT 1 FROM revoked_credential WHERE jti = ? AND expires_at > ?",
					jti,
					Math.floor(Date.now() / 1000),
				)
				.toArray().length > 0
		);
	}

	// ------------------------------------------------------------------
	// Authority role: policy, members, writers, notifications
	// ------------------------------------------------------------------

	private writePolicy(policy: SpacePolicy): void {
		this.sql.exec(
			`INSERT INTO config (id, policy) VALUES (1, ?)
			 ON CONFLICT (id) DO UPDATE SET policy = excluded.policy`,
			JSON.stringify(policy),
		);
	}

	private readPolicy(): SpacePolicy | null {
		const row = this.sql
			.exec("SELECT policy FROM config WHERE id = 1")
			.toArray()[0];
		return row ? (JSON.parse(row.policy as string) as SpacePolicy) : null;
	}

	/**
	 * State needed to answer getSpaceCredential and notifyWrite: meta
	 * (including the deletion tombstone) and the policy. Never throws on a
	 * deleted space — a late credential request must get SpaceDeleted, not
	 * SpaceNotFound, and that mapping is the caller's.
	 */
	async rpcGetAuthorityState(): Promise<{
		meta: SpaceMeta | null;
		policy: SpacePolicy | null;
	}> {
		await this.ensureOpen();
		return { meta: this.readMeta(), policy: this.readPolicy() };
	}

	private hasRecord(collection: string, rkey: string): boolean {
		return (
			this.sql
				.exec(
					"SELECT 1 FROM record WHERE collection = ? AND rkey = ?",
					collection,
					rkey,
				)
				.toArray().length > 0
		);
	}

	private async preparePut(
		collection: string,
		rkey: string,
		record: Record<string, unknown>,
	): Promise<PreparedSpaceWrite> {
		const prepared = await prepareRecord(record);
		return {
			action: this.hasRecord(collection, rkey) ? "update" : "create",
			collection,
			rkey,
			cid: prepared.cid,
			bytes: prepared.bytes,
			blobCids: prepared.blobCids,
		};
	}

	private prepareDeleteIfExists(
		collection: string,
		rkey: string,
	): PreparedSpaceWrite[] {
		return this.hasRecord(collection, rkey)
			? [{ action: "delete", collection, rkey }]
			: [];
	}

	/** Publish, update or withdraw the policy record to match the policy. */
	private async preparePolicyRecordWrites(
		policy: SpacePolicy,
	): Promise<PreparedSpaceWrite[]> {
		if (isPolicyPublished(policy)) {
			return [
				await this.preparePut(POLICY_COLLECTION, POLICY_RKEY, {
					$type: POLICY_COLLECTION,
					policy,
				}),
			];
		}
		return this.prepareDeleteIfExists(POLICY_COLLECTION, POLICY_RKEY);
	}

	/**
	 * Publish, update or withdraw a member's record to match their entry.
	 * `access` is omitted for a DID that is no longer a member.
	 */
	private async prepareMemberRecordWrites(
		policy: SpacePolicy,
		did: string,
		access?: { read: boolean; write: boolean },
	): Promise<PreparedSpaceWrite[]> {
		const rkey = didToRecordKey(did);
		if (access && areMembersPublished(policy)) {
			return [
				await this.preparePut(MEMBER_COLLECTION, rkey, {
					$type: MEMBER_COLLECTION,
					read: access.read,
					write: access.write,
				}),
			];
		}
		return this.prepareDeleteIfExists(MEMBER_COLLECTION, rkey);
	}

	private readMembers(): SpaceMember[] {
		return this.sql
			.exec("SELECT did, can_read, can_write FROM member ORDER BY did")
			.toArray()
			.map((row) => ({
				did: row.did as string,
				read: (row.can_read as number) === 1,
				write: (row.can_write as number) === 1,
			}));
	}

	/**
	 * Replace the policy wholesale. A different `$type` migrates the space:
	 * state held by the previous policy (the member list) is discarded, and
	 * a published member list is withdrawn with it.
	 */
	async rpcUpdatePolicy(next: SpacePolicy): Promise<RepoCommitResult | null> {
		await this.ensureOpen();
		const { policy: current } = this.requirePolicy();
		const writes = await this.preparePolicyRecordWrites(next);
		if (areMembersPublished(current) !== areMembersPublished(next)) {
			for (const member of this.readMembers()) {
				writes.push(
					...(await this.prepareMemberRecordWrites(next, member.did, member)),
				);
			}
		}
		return this.ctx.storage.transactionSync(() => {
			this.writePolicy(next);
			if (current.$type !== next.$type) {
				this.sql.exec("DELETE FROM member");
			}
			return this.applyWritesSync(writes);
		});
	}

	async rpcPutMember(
		did: string,
		access: { read: boolean; write: boolean },
	): Promise<RepoCommitResult | null> {
		await this.ensureOpen();
		const { policy } = this.requirePolicy();
		assertMemberspace(policy);
		const writes = await this.prepareMemberRecordWrites(policy, did, access);
		return this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO member (did, can_read, can_write) VALUES (?, ?, ?)
				 ON CONFLICT (did) DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write`,
				did,
				access.read ? 1 : 0,
				access.write ? 1 : 0,
			);
			if (!access.write) {
				this.sql.exec("DELETE FROM writer WHERE did = ?", did);
			}
			return this.applyWritesSync(writes);
		});
	}

	async rpcRemoveMember(did: string): Promise<RepoCommitResult | null> {
		await this.ensureOpen();
		const { policy } = this.requirePolicy();
		assertMemberspace(policy);
		const writes = await this.prepareMemberRecordWrites(policy, did);
		return this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM member WHERE did = ?", did);
			this.sql.exec("DELETE FROM writer WHERE did = ?", did);
			return this.applyWritesSync(writes);
		});
	}

	async rpcGetMember(did: string): Promise<SpaceMember | null> {
		await this.ensureOpen();
		this.requirePolicy();
		const row = this.sql
			.exec("SELECT did, can_read, can_write FROM member WHERE did = ?", did)
			.toArray()[0];
		if (!row) return null;
		return {
			did: row.did as string,
			read: (row.can_read as number) === 1,
			write: (row.can_write as number) === 1,
		};
	}

	async rpcListMembers(params: {
		limit: number;
		afterDid?: string;
	}): Promise<{ members: SpaceMember[]; hasMore: boolean }> {
		await this.ensureOpen();
		const { policy } = this.requirePolicy();
		assertMemberspace(policy);
		const args: unknown[] = [];
		let where = "1=1";
		if (params.afterDid) {
			where += " AND did > ?";
			args.push(params.afterDid);
		}
		const rows = this.sql
			.exec(
				`SELECT did, can_read, can_write FROM member WHERE ${where} ORDER BY did ASC LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return {
			members: page.map((row) => ({
				did: row.did as string,
				read: (row.can_read as number) === 1,
				write: (row.can_write as number) === 1,
			})),
			hasMore,
		};
	}

	/**
	 * Record a writer's latest (repoRev, data), from notifyWrite or own
	 * writes, and advance the space sequence. Monotonic per writer: a
	 * delayed or replayed notification with an older (or equal) rev changes
	 * nothing and returns null, so callers skip fan-out for stale state.
	 */
	async rpcRecordWriter(
		did: string,
		repoRev: string,
		data: Uint8Array,
	): Promise<SpaceSequence | null> {
		await this.ensureOpen();
		this.requirePolicy();
		return this.ctx.storage.transactionSync(() => {
			const existing = this.sql
				.exec("SELECT repo_rev FROM writer WHERE did = ?", did)
				.toArray()[0];
			if (existing && (existing.repo_rev as string) >= repoRev) return null;
			const latest = this.sql
				.exec("SELECT MAX(space_rev) AS rev FROM writer")
				.toArray()[0]?.rev as string | null;
			const spaceRev = nextRev(latest);
			this.sql.exec(
				`INSERT INTO writer (did, repo_rev, data, space_rev) VALUES (?, ?, ?, ?)
				 ON CONFLICT (did) DO UPDATE SET repo_rev = excluded.repo_rev, data = excluded.data, space_rev = excluded.space_rev`,
				did,
				repoRev,
				data,
				spaceRev,
			);
			return { spaceRev, ...(latest ? { prevSpaceRev: latest } : {}) };
		});
	}

	/**
	 * Drop an account from the writer set. It is tracked again if it later
	 * writes while still authorised. Idempotent.
	 */
	async rpcRemoveWriter(did: string): Promise<void> {
		await this.ensureOpen();
		this.requirePolicy();
		this.sql.exec("DELETE FROM writer WHERE did = ?", did);
	}

	/** The writer set in ascending space revision, after `cursor`. */
	async rpcListWriters(params: {
		limit: number;
		cursor?: string;
	}): Promise<SpaceWriter[]> {
		await this.ensureOpen();
		this.requirePolicy();
		return this.sql
			.exec(
				`SELECT did, repo_rev, data, space_rev FROM writer
				 ${params.cursor ? "WHERE space_rev > ?" : ""}
				 ORDER BY space_rev ASC LIMIT ?`,
				...(params.cursor ? [params.cursor] : []),
				params.limit,
			)
			.toArray()
			.map((row) => ({
				did: row.did as string,
				repoRev: row.repo_rev as string,
				data: new Uint8Array(row.data as ArrayBuffer),
				spaceRev: row.space_rev as string,
			}));
	}

	/** The space's host-side state, for migrating its authority's account. */
	async rpcExportMeta(): Promise<{
		policy: SpacePolicy;
		members: SpaceMember[];
		writers: SpaceWriter[];
	}> {
		await this.ensureOpen();
		const { policy } = this.requirePolicy();
		const writers = this.sql
			.exec("SELECT did, repo_rev, data, space_rev FROM writer ORDER BY did")
			.toArray()
			.map((row) => ({
				did: row.did as string,
				repoRev: row.repo_rev as string,
				data: new Uint8Array(row.data as ArrayBuffer),
				spaceRev: row.space_rev as string,
			}));
		return { policy, members: this.readMembers(), writers };
	}

	/**
	 * Import a space exported by its previous host, replacing whatever this
	 * host held for it, so a migration step can be retried. Publishing is
	 * left to the authority's repo, which arrives afterwards with importRepo.
	 * Registrations, revocations and tombstones are not carried over.
	 */
	async rpcImportMeta(params: {
		uri: string;
		authority: string;
		type: string;
		skey: string;
		policy: SpacePolicy;
		members: SpaceMember[];
		writers: SpaceWriter[];
	}): Promise<void> {
		await this.ensureOpen();
		const existing = this.readMeta();
		if (existing && existing.uri !== params.uri) {
			throw new SpaceError(
				"InvalidSpaceUri",
				`Space DO already holds ${existing.uri}`,
			);
		}
		this.ctx.storage.transactionSync(() => {
			if (!existing) {
				this.sql.exec(
					`INSERT INTO meta (uri, authority, type, skey, is_authority, created_at, deleted_at, schema_version)
					 VALUES (?, ?, ?, ?, 1, ?, NULL, ?)`,
					params.uri,
					params.authority,
					params.type,
					params.skey,
					new Date().toISOString(),
					SPACE_SCHEMA_VERSION,
				);
			} else {
				this.sql.exec("UPDATE meta SET deleted_at = NULL, is_authority = 1");
			}
			this.writePolicy(params.policy);
			this.sql.exec("DELETE FROM member");
			for (const member of params.members) {
				this.sql.exec(
					"INSERT INTO member (did, can_read, can_write) VALUES (?, ?, ?)",
					member.did,
					member.read ? 1 : 0,
					member.write ? 1 : 0,
				);
			}
			this.sql.exec("DELETE FROM writer");
			for (const writer of params.writers) {
				this.sql.exec(
					"INSERT INTO writer (did, repo_rev, data, space_rev) VALUES (?, ?, ?, ?)",
					writer.did,
					writer.repoRev,
					writer.data,
					writer.spaceRev,
				);
			}
		});
	}

	/**
	 * Register a syncing service for write notifications. The endpoint was
	 * resolved by the Worker at registration time so fan-out never resolves
	 * DIDs. Re-registration replaces the endpoint and extends the expiry.
	 */
	async rpcRegisterNotify(
		service: string,
		endpoint: string,
	): Promise<{ expiresAt: string }> {
		await this.ensureOpen();
		this.requirePolicy();
		const expiresAt = new Date(
			Date.now() + NOTIFY_REGISTRATION_DAYS * DAY_MS,
		).toISOString();
		this.sql.exec(
			`INSERT INTO notify_registration (service, endpoint, expires_at) VALUES (?, ?, ?)
			 ON CONFLICT (service) DO UPDATE SET endpoint = excluded.endpoint, expires_at = excluded.expires_at`,
			service,
			endpoint,
			expiresAt,
		);
		return { expiresAt };
	}

	/** Idempotent: succeeds whether or not a registration existed. */
	async rpcUnregisterNotify(service: string): Promise<void> {
		await this.ensureOpen();
		this.requireLiveMeta();
		this.sql.exec("DELETE FROM notify_registration WHERE service = ?", service);
	}

	private activeRegistrations(): Array<{
		service: string;
		endpoint: string;
		expiresAt: string;
	}> {
		return this.sql
			.exec(
				"SELECT service, endpoint, expires_at FROM notify_registration WHERE expires_at > ?",
				new Date().toISOString(),
			)
			.toArray()
			.map((r) => ({
				service: r.service as string,
				endpoint: r.endpoint as string,
				expiresAt: r.expires_at as string,
			}));
	}

	async rpcGetActiveRegistrations(): Promise<
		Array<{ service: string; endpoint: string; expiresAt: string }>
	> {
		await this.ensureOpen();
		return this.activeRegistrations();
	}

	/**
	 * Queue outbound notifications for the alarm to deliver with bounded
	 * retries. An item with a coalesce key replaces any pending item with
	 * the same key, resetting its backoff and deadline.
	 */
	async rpcEnqueueNotify(
		items: NotifyItem[],
		opts: { delayMs?: number } = {},
	): Promise<void> {
		await this.ensureOpen();
		if (items.length === 0) return;
		const nextAt = Date.now() + (opts.delayMs ?? 0);
		for (const item of items) {
			const body = JSON.stringify({
				endpoint: item.endpoint,
				lxm: item.lxm,
				body: item.body,
			});
			this.sql.exec(
				`INSERT INTO notify_queue (service, body, attempts, next_at, deadline, coalesce_key)
				 VALUES (?, ?, 0, ?, ?, ?)
				 ON CONFLICT (coalesce_key) DO UPDATE SET
					service = excluded.service, body = excluded.body, attempts = 0,
					next_at = excluded.next_at, deadline = excluded.deadline`,
				item.service,
				body,
				nextAt,
				item.deadline ?? null,
				item.coalesceKey ?? null,
			);
		}
		await this.scheduleNextAlarm();
	}

	/** Drop a pending coalesced notification, e.g. once a newer one landed. */
	async rpcClearNotify(coalesceKey: string): Promise<void> {
		await this.ensureOpen();
		this.sql.exec(
			"DELETE FROM notify_queue WHERE coalesce_key = ?",
			coalesceKey,
		);
	}

	// ------------------------------------------------------------------
	// Deletion and status
	// ------------------------------------------------------------------

	/**
	 * Tombstone the space (authority role) and delete the authority's own
	 * repo in it. Enqueues nothing itself — the caller enqueues
	 * `notifySpaceDeleted` to the returned registrations. The meta row is
	 * retained so a late getSpaceCredential can answer SpaceDeleted rather
	 * than SpaceNotFound. Idempotent.
	 */
	async rpcDeleteSpace(): Promise<{
		registrations: Array<{
			service: string;
			endpoint: string;
			expiresAt: string;
		}>;
	}> {
		await this.ensureOpen();
		const meta = this.readMeta();
		if (!meta) {
			throw new SpaceError("SpaceNotFound", "Space is not initialised");
		}
		if (meta.deletedAt) return { registrations: [] };
		const registrations = this.activeRegistrations();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE meta SET deleted_at = ?", new Date().toISOString());
			for (const table of [
				"record",
				"record_blob",
				"repo_state",
				"oplog",
				"config",
				"member",
				"writer",
				"notify_registration",
				"replay",
			]) {
				this.sql.exec(`DELETE FROM ${table}`);
			}
		});
		return { registrations };
	}

	/** Wipe everything, including queued notifications and alarms. */
	async rpcDestroy(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.initialized = false;
		this.outdated = false;
	}

	async rpcStatus(): Promise<{
		meta: SpaceMeta | null;
		outdated: boolean;
		policyType: string | null;
		recordCount: number;
		memberCount: number;
		writerCount: number;
		queuedNotifications: number;
	}> {
		await this.ensureInitialized();
		if (this.outdated) {
			return {
				meta: null,
				outdated: true,
				policyType: null,
				recordCount: 0,
				memberCount: 0,
				writerCount: 0,
				queuedNotifications: 0,
			};
		}
		const count = (table: string): number =>
			(this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]
				?.n as number) ?? 0;
		return {
			meta: this.readMeta(),
			outdated: false,
			policyType: this.readPolicy()?.$type ?? null,
			recordCount: count("record"),
			memberCount: count("member"),
			writerCount: count("writer"),
			queuedNotifications: count("notify_queue"),
		};
	}

	// ------------------------------------------------------------------
	// Alarm: notification delivery, oplog compaction, expiry cleanup
	// ------------------------------------------------------------------

	override async alarm(): Promise<void> {
		await this.ensureInitialized();
		if (this.outdated) return;

		await this.deliverQueuedNotifications();
		this.runMaintenanceIfDue();
		await this.scheduleNextAlarm();
	}

	private async deliverQueuedNotifications(): Promise<void> {
		const now = Date.now();
		this.sql.exec(
			"DELETE FROM notify_queue WHERE deadline IS NOT NULL AND deadline <= ?",
			now,
		);
		const due = this.sql
			.exec(
				"SELECT id, service, body, attempts, next_at, deadline FROM notify_queue WHERE next_at <= ? ORDER BY next_at ASC LIMIT ?",
				now,
				NOTIFY_BATCH,
			)
			.toArray() as unknown as QueueRow[];
		if (due.length === 0) return;

		const host = await this.getHostConfig();
		const keypair = await host.getKeypair();

		for (const row of due) {
			let delivered = false;
			let retryable = true;
			try {
				const parsed = JSON.parse(row.body) as {
					endpoint: string;
					lxm: string;
					body: Record<string, unknown>;
				};
				const token = await createServiceJwt(
					{ iss: host.operatorDid, aud: row.service, lxm: parsed.lxm },
					keypair,
				);
				const res = await fetch(`${parsed.endpoint}/xrpc/${parsed.lxm}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(parsed.body),
					signal: AbortSignal.timeout(10_000),
				});
				delivered = res.ok;
				if (!res.ok) {
					retryable = isRetryableStatus(res.status);
					console.warn(
						`notify ${parsed.lxm} to ${row.service} failed: ${res.status}`,
					);
				}
			} catch (err) {
				console.warn(`notify to ${row.service} errored:`, err);
			}

			const attempts = row.attempts + 1;
			const exhausted =
				row.deadline === null ? attempts >= NOTIFY_MAX_ATTEMPTS : false;
			if (delivered || !retryable || exhausted) {
				this.sql.exec("DELETE FROM notify_queue WHERE id = ?", row.id);
			} else {
				this.sql.exec(
					"UPDATE notify_queue SET attempts = ?, next_at = ? WHERE id = ?",
					attempts,
					Date.now() +
						Math.min(
							NOTIFY_BACKOFF_BASE_MS * 2 ** row.attempts,
							NOTIFY_BACKOFF_MAX_MS,
						),
					row.id,
				);
			}
		}
	}

	private runMaintenanceIfDue(): void {
		const now = Date.now();
		const last =
			(this.sql
				.exec(
					"SELECT expires_at FROM replay WHERE kind = '__maintenance' AND key = 'last' LIMIT 1",
				)
				.toArray()[0]?.expires_at as number | undefined) ?? 0;
		if (now - last < MAINTENANCE_INTERVAL_MS) return;

		// Oplog compaction: 30 days or 10,000 ops, whichever is smaller.
		// DO SQLite is billed and capped; the reference has no compaction
		// yet, ours must.
		this.sql.exec(
			"DELETE FROM oplog WHERE rev < ?",
			tidCutoff(OPLOG_RETENTION_DAYS * DAY_MS),
		);
		const excess = this.sql
			.exec(
				"SELECT rev, idx FROM oplog ORDER BY rev DESC, idx DESC LIMIT 1 OFFSET ?",
				OPLOG_RETENTION_OPS,
			)
			.toArray()[0];
		if (excess) {
			this.sql.exec(
				"DELETE FROM oplog WHERE rev < ? OR (rev = ? AND idx <= ?)",
				excess.rev,
				excess.rev,
				excess.idx,
			);
		}

		const nowSec = Math.floor(now / 1000);
		// Replay and revocation entries expire on their own clock.
		this.sql.exec(
			"DELETE FROM replay WHERE kind != '__maintenance' AND expires_at < ?",
			nowSec,
		);
		this.sql.exec(
			"DELETE FROM revoked_credential WHERE expires_at <= ?",
			nowSec,
		);
		// Expired notify registrations.
		this.sql.exec(
			"DELETE FROM notify_registration WHERE expires_at <= ?",
			new Date(now).toISOString(),
		);

		this.sql.exec(
			`INSERT INTO replay (kind, key, expires_at) VALUES ('__maintenance', 'last', ?)
			 ON CONFLICT (kind, key) DO UPDATE SET expires_at = excluded.expires_at`,
			now,
		);
	}

	private async scheduleNextAlarm(): Promise<void> {
		const nextQueue = this.sql
			.exec("SELECT MIN(next_at) AS next FROM notify_queue")
			.toArray()[0]?.next as number | null;
		const nextMaintenance = Date.now() + MAINTENANCE_INTERVAL_MS;
		const next = nextQueue
			? Math.min(Math.max(nextQueue, Date.now() + 1000), nextMaintenance)
			: nextMaintenance;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || next < current) {
			await this.ctx.storage.setAlarm(next);
		}
	}
}
