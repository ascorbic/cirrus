/**
 * SpaceIndexDurableObject – singleton registry of space URIs with role
 * flags, timestamps and lifecycle state, addressed by `idFromName("spaces")`.
 *
 * Serves listSpaces, the dashboard, export and reset. Nothing reads it on
 * the hot path: the space DO id is derived from the URI, so reads never
 * depend on the index. Creation is a two-step write — the index entry is
 * written `pending`, the space DO is initialised, then the entry is marked
 * `active`. A `pending` entry that never activates is cleaned up by this
 * DO's alarm.
 */

import { DurableObject } from "cloudflare:workers";
import { INDEX_DO_SCHEMA, PENDING_ENTRY_TTL_MS, SPACE_SCHEMA_VERSION } from "./schema.js";

export type SpaceIndexState = "pending" | "active" | "deleted";

export interface SpaceIndexEntry {
	uri: string;
	authority: string;
	type: string;
	skey: string;
	isAuthority: boolean;
	state: SpaceIndexState;
	createdAt: string;
	updatedAt: string;
}

const ALARM_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class SpaceIndexDurableObject<Env = unknown> extends DurableObject<Env> {
	private sql: SqlStorage;
	private initialized = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.initialized) return;
			this.sql.exec(INDEX_DO_SCHEMA);
			this.initialized = true;
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm === null) {
				await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
			}
		});
	}

	/** Register (or revive) an entry in `pending` state. */
	async rpcRegister(entry: {
		uri: string;
		authority: string;
		type: string;
		skey: string;
		isAuthority: boolean;
	}): Promise<void> {
		await this.ensureInitialized();
		const now = new Date().toISOString();
		this.sql.exec(
			`INSERT INTO space (uri, authority, type, skey, is_authority, state, created_at, updated_at, schema_version)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
			 ON CONFLICT (uri) DO UPDATE SET
				state = CASE WHEN space.state = 'active' THEN 'active' ELSE 'pending' END,
				is_authority = excluded.is_authority,
				updated_at = excluded.updated_at`,
			entry.uri,
			entry.authority,
			entry.type,
			entry.skey,
			entry.isAuthority ? 1 : 0,
			now,
			now,
			SPACE_SCHEMA_VERSION,
		);
	}

	async rpcActivate(uri: string): Promise<void> {
		await this.ensureInitialized();
		this.sql.exec(
			"UPDATE space SET state = 'active', updated_at = ? WHERE uri = ?",
			new Date().toISOString(),
			uri,
		);
	}

	async rpcMarkDeleted(uri: string): Promise<void> {
		await this.ensureInitialized();
		this.sql.exec(
			"UPDATE space SET state = 'deleted', updated_at = ? WHERE uri = ?",
			new Date().toISOString(),
			uri,
		);
	}

	async rpcGet(uri: string): Promise<SpaceIndexEntry | null> {
		await this.ensureInitialized();
		const row = this.sql
			.exec("SELECT * FROM space WHERE uri = ?", uri)
			.toArray()[0];
		return row ? toEntry(row) : null;
	}

	async rpcList(params: {
		type?: string;
		authority?: string;
		state?: SpaceIndexState;
		limit: number;
		afterUri?: string;
	}): Promise<{ spaces: SpaceIndexEntry[]; hasMore: boolean }> {
		await this.ensureInitialized();
		const args: unknown[] = [];
		let where = "1=1";
		if (params.type) {
			where += " AND type = ?";
			args.push(params.type);
		}
		if (params.authority) {
			where += " AND authority = ?";
			args.push(params.authority);
		}
		if (params.state) {
			where += " AND state = ?";
			args.push(params.state);
		}
		if (params.afterUri) {
			where += " AND uri > ?";
			args.push(params.afterUri);
		}
		const rows = this.sql
			.exec(
				`SELECT * FROM space WHERE ${where} ORDER BY uri ASC LIMIT ?`,
				...args,
				params.limit + 1,
			)
			.toArray();
		const hasMore = rows.length > params.limit;
		const page = hasMore ? rows.slice(0, params.limit) : rows;
		return { spaces: page.map(toEntry), hasMore };
	}

	async rpcStats(): Promise<{
		total: number;
		active: number;
		pending: number;
		deleted: number;
		hosted: number;
	}> {
		await this.ensureInitialized();
		const count = (where: string): number =>
			(this.sql
				.exec(`SELECT COUNT(*) AS n FROM space WHERE ${where}`)
				.toArray()[0]?.n as number) ?? 0;
		return {
			total: count("1=1"),
			active: count("state = 'active'"),
			pending: count("state = 'pending'"),
			deleted: count("state = 'deleted'"),
			hosted: count("is_authority = 1 AND state = 'active'"),
		};
	}

	/** Wipe the registry (spaces reset). */
	async rpcDestroy(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.initialized = false;
	}

	/**
	 * Tombstone `pending` entries that never activated. They become
	 * `deleted` rather than being removed: a crash between the space DO's
	 * initialisation and the index activation leaves real DO storage
	 * behind, and the index row is the only durable manifest `spaces reset`
	 * has for finding and destroying it.
	 */
	override async alarm(): Promise<void> {
		await this.ensureInitialized();
		const cutoff = new Date(Date.now() - PENDING_ENTRY_TTL_MS).toISOString();
		this.sql.exec(
			"UPDATE space SET state = 'deleted', updated_at = ? WHERE state = 'pending' AND updated_at < ?",
			new Date().toISOString(),
			cutoff,
		);
		await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}
}

function toEntry(row: Record<string, unknown>): SpaceIndexEntry {
	return {
		uri: row.uri as string,
		authority: row.authority as string,
		type: row.type as string,
		skey: row.skey as string,
		isAuthority: (row.is_authority as number) === 1,
		state: row.state as SpaceIndexState,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}
