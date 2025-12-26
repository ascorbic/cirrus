import { DurableObject } from "cloudflare:workers"
import { SqliteRepoStorage } from "./storage"
import type { Env } from "./env"

/**
 * Account Durable Object - manages a single user's AT Protocol repository.
 *
 * This DO provides:
 * - SQLite-backed block storage for the repository
 * - Firehose WebSocket connections
 * - Sequence number management
 */
export class AccountDurableObject extends DurableObject<Env> {
	private storage: SqliteRepoStorage | null = null
	private initialized = false

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
	}

	/**
	 * Initialize the storage adapter. Called lazily on first access.
	 */
	private async ensureInitialized(): Promise<SqliteRepoStorage> {
		if (!this.initialized) {
			await this.ctx.blockConcurrencyWhile(async () => {
				this.storage = new SqliteRepoStorage(this.ctx.storage.sql)
				this.storage.initSchema()
				this.initialized = true
			})
		}
		return this.storage!
	}

	/**
	 * Get the storage adapter for direct access (used by tests and internal operations).
	 */
	async getStorage(): Promise<SqliteRepoStorage> {
		return this.ensureInitialized()
	}

	/**
	 * HTTP fetch handler - routes XRPC requests.
	 */
	async fetch(request: Request): Promise<Response> {
		// Ensure storage is initialized
		await this.ensureInitialized()

		// Basic routing placeholder
		const url = new URL(request.url)
		const path = url.pathname

		if (path === "/health") {
			return new Response("ok")
		}

		return new Response("Not found", { status: 404 })
	}
}
