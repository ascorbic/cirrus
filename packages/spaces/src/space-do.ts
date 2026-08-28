/**
 * SpaceDurableObject – one instance per space, addressed by
 * `idFromName(spaceUri)`.
 *
 * Holds everything Cirrus knows about that space: the operator's
 * permissioned repo (records, oplog, LtHash state, blob references) and,
 * when the operator is the authority, the simplespace config, member list,
 * writer set, notification registrations and the outbound notification
 * queue. Also the replay tables for DPoP proofs and delegation tokens
 * presented against the space.
 *
 * Constraints inherited from the Cirrus architecture:
 * - No R2 I/O in here, ever. Blobs are the Worker's job.
 * - Commits are never signed here; the signing key never enters this class
 *   except through {@link SpaceHostConfig.getKeypair}, which is used only
 *   for outbound notification service JWTs from the alarm.
 * - The host supplies its identity via {@link getHostConfig}; this class
 *   must not read `env.DID`. If it ever contains a branch on which host is
 *   running it, the boundary has failed.
 */

import { DurableObject } from "cloudflare:workers";
import { RepoCommit } from "@atproto/space";
import { SpaceError } from "./errors.js";
import {
	NOTIFY_BACKOFF_BASE_MS,
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
	NotifyItem,
	OplogEntry,
	PreparedSpaceWrite,
	RepoState,
	SpaceAppAccess,
	SpaceConfig,
	SpaceHostConfig,
	SpaceMeta,
	SpacePolicy,
	SpaceRecordRow,
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
}

export abstract class SpaceDurableObject<Env = unknown> extends DurableObject<Env> {
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
	protected abstract getHostConfig(): SpaceHostConfig | Promise<SpaceHostConfig>;

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
				if (
					row &&
					(row.schema_version as number) !== SPACE_SCHEMA_VERSION
				) {
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

	async rpcGetMeta(): Promise<SpaceMeta | null> {
		await this.ensureOpen();
		return this.readMeta();
	}

	/**
	 * Initialise this DO as the operator's repo in a space (either role).
	 * Idempotent for an existing live space with matching identity.
	 */
	async rpcInit(params: {
		uri: string;
		authority: string;
		type: string;
		skey: string;
		isAuthority: boolean;
		config?: SpaceConfig;
	}): Promise<void> {
		await this.ensureOpen();
		const existing = this.readMeta();
		if (existing) {
			if (existing.uri !== params.uri) {
				throw new SpaceError(
					"InvalidSpaceUri",
					`Space DO already holds ${existing.uri}`,
				);
			}
			if (!existing.deletedAt) {
				if (params.isAuthority && params.config) {
					const hasConfig =
						this.sql.exec("SELECT id FROM config").toArray().length > 0;
					if (hasConfig) {
						throw new SpaceError(
							"SpaceAlreadyExists",
							`Space already exists: ${params.uri}`,
						);
					}
					this.writeConfig(params.config);
				}
				return;
			}
			// A previously deleted space may be created again: tables were
			// wiped at deletion, so reviving is a fresh start.
			this.sql.exec(
				"UPDATE meta SET deleted_at = NULL, created_at = ?, is_authority = ?",
				new Date().toISOString(),
				params.isAuthority ? 1 : 0,
			);
			if (params.config) this.writeConfig(params.config);
			return;
		}
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
		if (params.config) this.writeConfig(params.config);
	}

	// ------------------------------------------------------------------
	// Permissioned repo: writes
	// ------------------------------------------------------------------

	async rpcApplyWrites(
		writes: PreparedSpaceWrite[],
	): Promise<ApplyWritesResult> {
		await this.ensureOpen();
		this.requireLiveMeta();

		return this.ctx.storage.transactionSync(() => {
			const stateRow = this.sql
				.exec("SELECT set_hash, rev FROM repo_state WHERE id = 1")
				.toArray()[0];
			const prevRev = stateRow ? (stateRow.rev as string) : null;
			const commit = RepoCommit.fromState(
				stateRow ? new Uint8Array(stateRow.set_hash as ArrayBuffer) : null,
			);
			const rev = nextRev(prevRev);
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
					this.sql.exec(
						"DELETE FROM record WHERE collection = ? AND rkey = ?",
						write.collection,
						write.rkey,
					);
					this.sql.exec(
						"DELETE FROM record_blob WHERE collection = ? AND rkey = ?",
						write.collection,
						write.rkey,
					);
					commit.setHash.remove(
						`${write.collection}/${write.rkey}/${prev}`,
					);
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
				this.sql.exec(
					"DELETE FROM record_blob WHERE collection = ? AND rkey = ?",
					write.collection,
					write.rkey,
				);
				for (const blobCid of write.blobCids) {
					this.sql.exec(
						"INSERT OR IGNORE INTO record_blob (blob_cid, collection, rkey) VALUES (?, ?, ?)",
						blobCid,
						write.collection,
						write.rkey,
					);
				}
				if (prev) {
					commit.setHash.remove(
						`${write.collection}/${write.rkey}/${prev}`,
					);
				}
				commit.setHash.add(
					`${write.collection}/${write.rkey}/${write.cid}`,
				);
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

			this.sql.exec(
				`INSERT INTO repo_state (id, set_hash, rev) VALUES (1, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET set_hash = excluded.set_hash, rev = excluded.rev`,
				commit.setHash.state(),
				rev,
			);

			return { rev, hash: commit.setHash.digest(), results };
		});
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

	// ------------------------------------------------------------------
	// Permissioned repo: reads
	// ------------------------------------------------------------------

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
			args.push(params.after.collection, params.after.collection, params.after.rkey);
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

	async rpcGetRepoState(): Promise<RepoState | null> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const row = this.sql
			.exec("SELECT set_hash, rev FROM repo_state WHERE id = 1")
			.toArray()[0];
		if (!row) return null;
		return {
			setHash: new Uint8Array(row.set_hash as ArrayBuffer),
			rev: row.rev as string,
		};
	}

	/**
	 * List oplog entries after `since` (a rev) or `after` (an exact cursor
	 * position). Creates and updates carry the record's current bytes when
	 * the oplog cid still matches the live record; superseded values are
	 * omitted. When the page reaches the head, `head` carries the repo
	 * state read in the same transaction so the Worker can attach a freshly
	 * signed commit without a state race.
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
			const values = params.excludeValues
				? ""
				: ", r.bytes AS live_bytes";
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
			const stateRow = this.sql
				.exec("SELECT set_hash, rev FROM repo_state WHERE id = 1")
				.toArray()[0];
			return {
				ops,
				...(stateRow
					? {
							head: {
								setHash: new Uint8Array(
									stateRow.set_hash as ArrayBuffer,
								),
								rev: stateRow.rev as string,
							},
						}
					: {}),
			};
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
	// Replay protection
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

	// ------------------------------------------------------------------
	// Authority role: config, members, writers, notifications
	// ------------------------------------------------------------------

	private writeConfig(config: SpaceConfig): void {
		this.sql.exec(
			`INSERT INTO config (id, policy, managing_app, app_access, app_allowed)
			 VALUES (1, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
				policy = excluded.policy,
				managing_app = excluded.managing_app,
				app_access = excluded.app_access,
				app_allowed = excluded.app_allowed`,
			config.policy.kind,
			config.policy.kind === "managing-app" ? config.policy.managingApp : null,
			config.appAccess.kind,
			JSON.stringify(
				config.appAccess.kind === "allowList" ? config.appAccess.allowed : [],
			),
		);
	}

	private readConfig(): SpaceConfig | null {
		const row = this.sql.exec("SELECT * FROM config WHERE id = 1").toArray()[0];
		if (!row) return null;
		const policyKind = row.policy as string;
		const policy: SpacePolicy =
			policyKind === "managing-app"
				? {
						kind: "managing-app",
						managingApp: row.managing_app as string,
					}
				: policyKind === "member-list"
					? { kind: "member-list" }
					: { kind: "public" };
		const appAccess: SpaceAppAccess =
			(row.app_access as string) === "allowList"
				? {
						kind: "allowList",
						allowed: JSON.parse(row.app_allowed as string) as string[],
					}
				: { kind: "open" };
		return { policy, appAccess };
	}

	/**
	 * State needed to answer getSpaceCredential: meta (including the
	 * deletion tombstone) and the simplespace config. Never throws on a
	 * deleted space — a late credential request must get SpaceDeleted, not
	 * SpaceNotFound, and that mapping is the caller's.
	 */
	async rpcGetAuthorityState(): Promise<{
		meta: SpaceMeta | null;
		config: SpaceConfig | null;
	}> {
		await this.ensureOpen();
		return { meta: this.readMeta(), config: this.readConfig() };
	}

	async rpcUpdateConfig(update: {
		policy?: SpacePolicy;
		appAccess?: SpaceAppAccess;
	}): Promise<void> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const current = this.readConfig();
		if (!current) {
			throw new SpaceError("SpaceNotFound", "Space has no configuration");
		}
		this.writeConfig({
			policy: update.policy ?? current.policy,
			appAccess: update.appAccess ?? current.appAccess,
		});
	}

	async rpcAddMember(did: string): Promise<void> {
		await this.ensureOpen();
		this.requireLiveMeta();
		this.sql.exec("INSERT OR IGNORE INTO member (did) VALUES (?)", did);
	}

	async rpcRemoveMember(did: string): Promise<void> {
		await this.ensureOpen();
		this.requireLiveMeta();
		this.sql.exec("DELETE FROM member WHERE did = ?", did);
	}

	async rpcIsMember(did: string): Promise<boolean> {
		await this.ensureOpen();
		this.requireLiveMeta();
		return (
			this.sql.exec("SELECT 1 FROM member WHERE did = ?", did).toArray()
				.length > 0
		);
	}

	async rpcListMembers(params: {
		limit: number;
		afterDid?: string;
	}): Promise<{ dids: string[]; hasMore: boolean }> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const args: unknown[] = [];
		let where = "1=1";
		if (params.afterDid) {
			where += " AND did > ?";
			args.push(params.afterDid);
		}
		const rows = this.sql
			.exec(
				`SELECT did FROM member WHERE ${where} ORDER BY did ASC LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return { dids: page.map((r) => r.did as string), hasMore };
	}

	/** Record a writer's latest (rev, hash), from notifyWrite or own writes. */
	async rpcRecordWriter(
		did: string,
		rev: string,
		hash: Uint8Array,
	): Promise<void> {
		await this.ensureOpen();
		this.requireLiveMeta();
		this.sql.exec(
			`INSERT INTO writer (did, rev, hash) VALUES (?, ?, ?)
			 ON CONFLICT (did) DO UPDATE SET rev = excluded.rev, hash = excluded.hash`,
			did,
			rev,
			hash,
		);
	}

	async rpcListWriters(params: {
		limit: number;
		afterDid?: string;
	}): Promise<{
		repos: Array<{ did: string; rev: string; hash: Uint8Array }>;
		hasMore: boolean;
	}> {
		await this.ensureOpen();
		this.requireLiveMeta();
		const args: unknown[] = [];
		let where = "1=1";
		if (params.afterDid) {
			where += " AND did > ?";
			args.push(params.afterDid);
		}
		const rows = this.sql
			.exec(
				`SELECT did, rev, hash FROM writer WHERE ${where} ORDER BY did ASC LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return {
			repos: page.map((r) => ({
				did: r.did as string,
				rev: r.rev as string,
				hash: new Uint8Array(r.hash as ArrayBuffer),
			})),
			hasMore,
		};
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
		this.requireLiveMeta();
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

	async rpcGetActiveRegistrations(): Promise<
		Array<{ service: string; endpoint: string }>
	> {
		await this.ensureOpen();
		return this.sql
			.exec(
				"SELECT service, endpoint FROM notify_registration WHERE expires_at > ?",
				new Date().toISOString(),
			)
			.toArray()
			.map((r) => ({
				service: r.service as string,
				endpoint: r.endpoint as string,
			}));
	}

	/**
	 * Queue outbound notifications for the alarm to deliver with bounded
	 * retries. The Worker only enqueues; delivery happens here because this
	 * DO holds no WebSocket and does no storage-bound work that a slow
	 * outbound fetch could pin.
	 */
	async rpcEnqueueNotify(items: NotifyItem[]): Promise<void> {
		await this.ensureOpen();
		if (items.length === 0) return;
		const now = Date.now();
		for (const item of items) {
			this.sql.exec(
				"INSERT INTO notify_queue (service, body, attempts, next_at) VALUES (?, ?, 0, ?)",
				item.service,
				JSON.stringify({
					endpoint: item.endpoint,
					lxm: item.lxm,
					body: item.body,
				}),
				now,
			);
		}
		await this.scheduleNextAlarm();
	}

	// ------------------------------------------------------------------
	// Deletion and status
	// ------------------------------------------------------------------

	/**
	 * Tombstone the space (authority role). Enqueues nothing itself — the
	 * caller reads the registrations from the result and enqueues
	 * `notifySpaceDeleted` before the queue rows would be unreachable. The
	 * meta row is retained so a late getSpaceCredential can answer
	 * SpaceDeleted rather than SpaceNotFound. Idempotent.
	 */
	async rpcDeleteSpace(): Promise<{
		registrations: Array<{ service: string; endpoint: string }>;
	}> {
		await this.ensureOpen();
		const meta = this.readMeta();
		if (!meta) {
			throw new SpaceError("SpaceNotFound", "Space is not initialised");
		}
		if (meta.deletedAt) return { registrations: [] };
		const registrations = await this.rpcGetActiveRegistrations();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE meta SET deleted_at = ?",
				new Date().toISOString(),
			);
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
			recordCount: count("record"),
			memberCount: count("member"),
			writerCount: count("writer"),
			queuedNotifications: count("notify_queue"),
		};
	}

	// ------------------------------------------------------------------
	// Alarm: notification fan-out, oplog compaction, replay cleanup
	// ------------------------------------------------------------------

	override async alarm(): Promise<void> {
		await this.ensureInitialized();
		if (this.outdated) return;

		await this.deliverQueuedNotifications();
		this.runMaintenanceIfDue();
		await this.scheduleNextAlarm();
	}

	private async deliverQueuedNotifications(): Promise<void> {
		const due = this.sql
			.exec(
				"SELECT id, service, body, attempts, next_at FROM notify_queue WHERE next_at <= ? ORDER BY next_at ASC LIMIT ?",
				Date.now(),
				NOTIFY_BATCH,
			)
			.toArray() as unknown as QueueRow[];
		if (due.length === 0) return;

		const meta = this.readMeta();
		if (!meta) {
			this.sql.exec("DELETE FROM notify_queue");
			return;
		}
		const host = await this.getHostConfig();
		const keypair = await host.getKeypair();

		for (const row of due) {
			let delivered = false;
			try {
				const parsed = JSON.parse(row.body) as {
					endpoint: string;
					lxm: string;
					body: Record<string, unknown>;
				};
				const token = await createServiceJwt(
					{ iss: meta.authority, aud: row.service, lxm: parsed.lxm },
					keypair,
				);
				const res = await fetch(`${parsed.endpoint}/xrpc/${parsed.lxm}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(parsed.body),
				});
				delivered = res.ok;
				if (!res.ok) {
					console.warn(
						`notify ${parsed.lxm} to ${row.service} failed: ${res.status}`,
					);
				}
			} catch (err) {
				console.warn(`notify to ${row.service} errored:`, err);
			}

			if (delivered || row.attempts + 1 >= NOTIFY_MAX_ATTEMPTS) {
				this.sql.exec("DELETE FROM notify_queue WHERE id = ?", row.id);
			} else {
				this.sql.exec(
					"UPDATE notify_queue SET attempts = ?, next_at = ? WHERE id = ?",
					row.attempts + 1,
					Date.now() + NOTIFY_BACKOFF_BASE_MS * 2 ** row.attempts,
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

		// Replay entries expire on their own clock.
		this.sql.exec(
			"DELETE FROM replay WHERE kind != '__maintenance' AND expires_at < ?",
			Math.floor(now / 1000),
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
