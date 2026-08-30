import { DurableObject } from "cloudflare:workers";
import type { Repo } from "@atproto/repo";
import { SqliteRepoStorage } from "./repo/storage";
import { SqliteOAuthStorage } from "./oauth-storage";
import { Sequencer } from "./repo/sequencer";
import { AccountStore } from "./account/store";
import { Firehose } from "./repo/firehose";
import { RepoEngine } from "./repo/engine";
import { RepoFacet } from "./repo/facet";
import { getRepoCar } from "./repo/sync";
import type { PDSEnv } from "./types";

/**
 * Account Durable Object - manages a single user's AT Protocol repository.
 *
 * This DO provides:
 * - SQLite-backed block storage for the repository
 * - AT Protocol Repo instance for repository operations
 * - Firehose WebSocket connections
 * - Sequence number management
 *
 * The Worker talks to it through three RpcTarget facets — repo(),
 * account() and authStore() — plus the fetch handler for WebSocket
 * upgrades and streaming responses.
 */
export class AccountDurableObject extends DurableObject<PDSEnv> {
	private storage: SqliteRepoStorage | null = null;
	private accountStore: AccountStore | null = null;
	private oauthStorage: SqliteOAuthStorage | null = null;
	private sequencer: Sequencer | null = null;
	private firehose: Firehose | null = null;
	private engine: RepoEngine | null = null;
	private repoFacet: RepoFacet | null = null;
	private storageInitialized = false;

	constructor(ctx: DurableObjectState, env: PDSEnv) {
		super(ctx, env);

		// Validate required environment variables at startup
		if (!env.SIGNING_KEY) {
			throw new Error("Missing required environment variable: SIGNING_KEY");
		}
		if (!env.DID) {
			throw new Error("Missing required environment variable: DID");
		}
	}

	/**
	 * Initialize the storage adapter. Called lazily on first storage access.
	 */
	private async ensureStorageInitialized(): Promise<void> {
		if (!this.storageInitialized) {
			await this.ctx.blockConcurrencyWhile(async () => {
				if (this.storageInitialized) return; // Double-check after acquiring lock

				// Determine initial active state from env var (default true for new accounts)
				const initialActive =
					this.env.INITIAL_ACTIVE === undefined ||
					this.env.INITIAL_ACTIVE === "true" ||
					this.env.INITIAL_ACTIVE === "1";

				this.storage = new SqliteRepoStorage(this.ctx.storage.sql);
				this.storage.initSchema(initialActive);
				this.accountStore = new AccountStore(this.ctx.storage.sql);
				this.accountStore.initSchema();
				this.oauthStorage = new SqliteOAuthStorage(this.ctx.storage.sql);
				this.oauthStorage.initSchema();
				this.sequencer = new Sequencer(this.ctx.storage.sql);
				this.firehose = new Firehose(this.sequencer, () =>
					this.ctx.getWebSockets(),
				);
				this.engine = new RepoEngine({
					storage: this.storage,
					sequencer: this.sequencer,
					did: this.env.DID,
					signingKey: this.env.SIGNING_KEY,
					lock: (fn) => this.ctx.blockConcurrencyWhile(fn),
					broadcast: (event) => this.firehose!.broadcast(event),
				});
				this.repoFacet = new RepoFacet(this.engine, this.storage);
				this.storageInitialized = true;

				// Run cleanup on initialization
				this.runCleanup();

				// Schedule periodic cleanup (run every 24 hours)
				const currentAlarm = await this.ctx.storage.getAlarm();
				if (currentAlarm === null) {
					await this.ctx.storage.setAlarm(Date.now() + 86400000); // 24 hours
				}
			});
		}
	}

	/**
	 * Run cleanup on storage to remove expired entries
	 */
	private runCleanup(): void {
		if (this.accountStore) {
			this.accountStore.cleanupPasskeyTokens();
		}
		if (this.oauthStorage) {
			this.oauthStorage.cleanup();
		}
	}

	/**
	 * Alarm handler for periodic cleanup
	 * Called by Cloudflare Workers when the alarm fires
	 */
	override async alarm(): Promise<void> {
		await this.ensureStorageInitialized();

		// Run cleanup
		this.runCleanup();

		// Schedule next cleanup in 24 hours
		await this.ctx.storage.setAlarm(Date.now() + 86400000);
	}

	/**
	 * Get the storage adapter for direct access (used by tests and internal operations).
	 */
	async getStorage(): Promise<SqliteRepoStorage> {
		await this.ensureStorageInitialized();
		return this.storage!;
	}

	/**
	 * Get the repo engine for repository operations.
	 */
	private async getEngine(): Promise<RepoEngine> {
		await this.ensureStorageInitialized();
		return this.engine!;
	}

	/**
	 * RPC facet: repository operations (records, sync, migration, blobs).
	 */
	async repo(): Promise<RepoFacet> {
		await this.ensureStorageInitialized();
		return this.repoFacet!;
	}

	/**
	 * RPC facet: person-account data (passkeys, app passwords, preferences, email).
	 */
	async account(): Promise<AccountStore> {
		await this.ensureStorageInitialized();
		return this.accountStore!;
	}

	/**
	 * RPC facet: OAuth storage (codes, tokens, clients, PAR, nonces,
	 * permission sets, WebAuthn challenges).
	 */
	async authStore(): Promise<SqliteOAuthStorage> {
		await this.ensureStorageInitialized();
		return this.oauthStorage!;
	}

	/**
	 * Get the Repo instance for repository operations.
	 */
	async getRepo(): Promise<Repo> {
		const engine = await this.getEngine();
		return engine.getRepo();
	}

	/**
	 * RPC method: Health check - verifies storage is accessible
	 */
	async healthCheck(): Promise<{ ok: true }> {
		this.ctx.storage.sql.exec("SELECT 1").toArray();
		return { ok: true };
	}

	/**
	 * RPC method: Firehose status - returns subscriber count and latest sequence
	 */
	async getFirehoseStatus(): Promise<{
		subscribers: Array<{
			connectedAt: number;
			cursor: number;
			ip: string | null;
		}>;
		latestSeq: number | null;
	}> {
		const sockets = this.ctx.getWebSockets();
		await this.ensureStorageInitialized();
		const seq = this.sequencer!.getLatestSeq();
		return {
			subscribers: sockets.map((ws) => {
				const attachment = ws.deserializeAttachment() as {
					cursor: number;
					connectedAt: number;
					ip: string | null;
				};
				return {
					connectedAt: attachment.connectedAt,
					cursor: attachment.cursor,
					ip: attachment.ip ?? null,
				};
			}),
			latestSeq: seq || null,
		};
	}

	/**
	 * Handle streaming getRepo via fetch (not RPC, to enable streaming response).
	 */
	private async handleGetRepo(): Promise<Response> {
		const storage = await this.getStorage();
		return getRepoCar(this.ctx.storage.sql, storage);
	}

	/**
	 * Handle WebSocket upgrade for firehose (subscribeRepos).
	 */
	async handleFirehoseUpgrade(request: Request): Promise<Response> {
		await this.ensureStorageInitialized();

		const url = new URL(request.url);
		const cursorParam = url.searchParams.get("cursor");
		const cursor = cursorParam ? parseInt(cursorParam, 10) : null;

		// Create WebSocket pair
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// Accept with hibernation
		this.ctx.acceptWebSocket(server);

		// Store cursor and client metadata in attachment
		server.serializeAttachment({
			cursor: cursor ?? 0,
			connectedAt: Date.now(),
			ip: request.headers.get("CF-Connecting-IP") ?? null,
		});

		// Backfill if cursor provided
		if (cursor !== null) {
			await this.firehose!.backfill(server, cursor);
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/**
	 * WebSocket message handler (hibernation API).
	 */
	override webSocketMessage(
		_ws: WebSocket,
		_message: string | ArrayBuffer,
	): void {
		// Firehose is server-push only, ignore client messages
	}

	/**
	 * WebSocket close handler (hibernation API).
	 */
	override webSocketClose(
		_ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): void {
		// Cleanup handled automatically by hibernation API
	}

	/**
	 * WebSocket error handler (hibernation API).
	 */
	override webSocketError(_ws: WebSocket, error: Error): void {
		console.error("WebSocket error:", error);
	}

	/**
	 * HTTP fetch handler for WebSocket upgrades and streaming responses.
	 * Used instead of RPC when the response can't be serialized (WebSocket)
	 * or when streaming is needed to avoid buffering large payloads (getRepo).
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/xrpc/com.atproto.sync.subscribeRepos") {
			return this.handleFirehoseUpgrade(request);
		}
		if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
			return this.handleGetRepo();
		}

		// All other requests should use RPC methods, not fetch
		return new Response("Method not allowed", { status: 405 });
	}
}
