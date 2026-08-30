import { DurableObject } from "cloudflare:workers";
import type { Repo } from "@atproto/repo";
import type { Secp256k1Keypair } from "@atproto/crypto";
import { SqliteRepoStorage } from "./repo/storage";
import { SqliteOAuthStorage } from "./oauth-storage";
import { Sequencer } from "./repo/sequencer";
import { BlobStore } from "./repo/blobs";
import { AccountStore } from "./account/store";
import { Firehose } from "./repo/firehose";
import { RepoEngine } from "./repo/engine";
import { getRepoCar, getBlocksCar, getRecordProofCar } from "./repo/sync";
import type { PDSEnv } from "./types";
import type { ValidationStatus } from "./validation";

/**
 * Account Durable Object - manages a single user's AT Protocol repository.
 *
 * This DO provides:
 * - SQLite-backed block storage for the repository
 * - AT Protocol Repo instance for repository operations
 * - Firehose WebSocket connections
 * - Sequence number management
 */
export class AccountDurableObject extends DurableObject<PDSEnv> {
	private storage: SqliteRepoStorage | null = null;
	private accountStore: AccountStore | null = null;
	private oauthStorage: SqliteOAuthStorage | null = null;
	private sequencer: Sequencer | null = null;
	private firehose: Firehose | null = null;
	private engine: RepoEngine | null = null;
	private blobStore: BlobStore | null = null;
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

		// Initialize BlobStore if R2 bucket is available
		if (env.BLOBS) {
			this.blobStore = new BlobStore(env.BLOBS, env.DID);
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
	 * Get the account store for person-account data.
	 */
	async getAccountStore(): Promise<AccountStore> {
		await this.ensureStorageInitialized();
		return this.accountStore!;
	}

	/**
	 * Get the OAuth storage adapter for OAuth operations.
	 */
	async getOAuthStorage(): Promise<SqliteOAuthStorage> {
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
	 * Ensure the account is active. Throws error if deactivated.
	 */
	async ensureActive(): Promise<void> {
		const engine = await this.getEngine();
		await engine.ensureActive();
	}

	/**
	 * Get the signing keypair for repository operations.
	 */
	async getKeypair(): Promise<Secp256k1Keypair> {
		const engine = await this.getEngine();
		return engine.getKeypair();
	}

	/**
	 * Update the Repo instance after mutations.
	 */
	async setRepo(repo: Repo): Promise<void> {
		const engine = await this.getEngine();
		engine.setRepo(repo);
	}

	/**
	 * RPC method: Get repo metadata for describeRepo
	 */
	async rpcDescribeRepo(): Promise<{
		did: string;
		collections: string[];
		cid: string;
	}> {
		const engine = await this.getEngine();
		return engine.describeRepo();
	}

	/**
	 * RPC method: Get a single record
	 */
	async rpcGetRecord(
		collection: string,
		rkey: string,
	): Promise<{
		cid: string;
		record: Rpc.Serializable<any>;
	} | null> {
		const engine = await this.getEngine();
		const result = await engine.getRecord(collection, rkey);
		if (!result) return null;
		return {
			cid: result.cid,
			record: result.record as Rpc.Serializable<any>,
		};
	}

	/**
	 * RPC method: List records in a collection
	 */
	async rpcListRecords(
		collection: string,
		opts: {
			limit: number;
			cursor?: string;
			reverse?: boolean;
		},
	): Promise<{
		records: Array<{ uri: string; cid: string; value: unknown }>;
		cursor?: string;
	}> {
		const engine = await this.getEngine();
		return engine.listRecords(collection, opts);
	}

	/**
	 * RPC method: Create a record
	 */
	async rpcCreateRecord(
		collection: string,
		rkey: string | undefined,
		record: unknown,
		validationStatus?: ValidationStatus,
	): Promise<{
		uri: string;
		cid: string;
		commit: { cid: string; rev: string };
		validationStatus?: ValidationStatus;
	}> {
		const engine = await this.getEngine();
		return engine.createRecord(collection, rkey, record, validationStatus);
	}

	/**
	 * RPC method: Delete a record
	 */
	async rpcDeleteRecord(
		collection: string,
		rkey: string,
	): Promise<{ commit: { cid: string; rev: string } } | null> {
		const engine = await this.getEngine();
		return engine.deleteRecord(collection, rkey);
	}

	/**
	 * RPC method: Put a record (create or update)
	 */
	async rpcPutRecord(
		collection: string,
		rkey: string,
		record: unknown,
		validationStatus?: ValidationStatus,
	): Promise<{
		uri: string;
		cid: string;
		commit: { cid: string; rev: string };
		validationStatus?: ValidationStatus;
	}> {
		const engine = await this.getEngine();
		return engine.putRecord(collection, rkey, record, validationStatus);
	}

	/**
	 * RPC method: Apply multiple writes (batch create/update/delete)
	 */
	async rpcApplyWrites(
		writes: Array<{
			$type: string;
			collection: string;
			rkey?: string;
			value?: unknown;
			validationStatus?: ValidationStatus;
		}>,
	): Promise<{
		commit: { cid: string; rev: string };
		results: Array<{
			$type: string;
			uri?: string;
			cid?: string;
			validationStatus?: ValidationStatus;
		}>;
	}> {
		const engine = await this.getEngine();
		return engine.applyWrites(writes);
	}

	/**
	 * RPC method: Get repo status
	 */
	async rpcGetRepoStatus(): Promise<{
		did: string;
		head: string;
		rev: string;
	}> {
		const engine = await this.getEngine();
		return engine.getStatus();
	}

	/**
	 * Handle streaming getRepo via fetch (not RPC, to enable streaming response).
	 */
	private async handleGetRepo(): Promise<Response> {
		const storage = await this.getStorage();
		return getRepoCar(this.ctx.storage.sql, storage);
	}

	/**
	 * RPC method: Get specific blocks by CID as CAR file
	 * Used for partial sync and migration.
	 */
	async rpcGetBlocks(cids: string[]): Promise<Uint8Array> {
		const storage = await this.getStorage();
		return getBlocksCar(storage, cids);
	}

	/**
	 * RPC method: Get record with proof as CAR file.
	 * Used by com.atproto.sync.getRecord for record verification.
	 */
	async rpcGetRecordProof(
		collection: string,
		rkey: string,
	): Promise<Uint8Array> {
		const storage = await this.getStorage();
		return getRecordProofCar(storage, collection, rkey);
	}

	/**
	 * RPC method: Import repo from CAR file
	 * This is used for account migration - importing an existing repository
	 * from another PDS.
	 */
	async rpcImportRepo(carBytes: Uint8Array): Promise<{
		did: string;
		rev: string;
		cid: string;
	}> {
		const engine = await this.getEngine();
		return engine.importRepo(carBytes);
	}

	/**
	 * RPC method: Record an already-stored blob's metadata.
	 *
	 * The blob bytes are written to R2 by the stateless Worker, not here.
	 * This DO is single-threaded and also holds the relay's firehose
	 * WebSocket; awaiting an R2 put inside it (R2 latency is independent of
	 * object size — even a small image can stall) pins the input gate, and
	 * Cloudflare resets the object when a storage op can't complete in time,
	 * dropping the firehose and desyncing the relay. Only the tiny tracking
	 * row needs the DO's SQLite.
	 */
	async rpcTrackBlob(
		cid: string,
		size: number,
		mimeType: string,
	): Promise<{ referenced: boolean }> {
		const storage = await this.getStorage();
		storage.trackImportedBlob(cid, size, mimeType);
		// Report whether an existing record already references this CID so
		// the Worker can promote the staged upload immediately (migration
		// uploads arrive after their referencing records were imported, so
		// no later record write will do it).
		return { referenced: storage.isBlobReferenced(cid) };
	}

	/**
	 * RPC method: Get a blob from R2
	 */
	async rpcGetBlob(cidStr: string): Promise<R2ObjectBody | null> {
		if (!this.blobStore) {
			throw new Error("Blob storage not configured");
		}
		return this.blobStore.getBlob(cidStr);
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
	 * RPC method: Get user preferences
	 */
	async rpcGetPreferences(): Promise<{ preferences: unknown[] }> {
		const store = await this.getAccountStore();
		const preferences = await store.getPreferences();
		return { preferences };
	}

	/**
	 * RPC method: Put user preferences
	 */
	async rpcPutPreferences(preferences: unknown[]): Promise<void> {
		const store = await this.getAccountStore();
		await store.putPreferences(preferences);
	}

	/**
	 * RPC method: Get stored email
	 */
	async rpcGetEmail(): Promise<{ email: string | null }> {
		const store = await this.getAccountStore();
		return { email: store.getEmail() };
	}

	/**
	 * RPC method: Update stored email
	 */
	async rpcUpdateEmail(email: string): Promise<void> {
		const store = await this.getAccountStore();
		store.setEmail(email);
	}

	/**
	 * RPC method: Get account activation state
	 */
	async rpcGetActive(): Promise<boolean> {
		const storage = await this.getStorage();
		return storage.getActive();
	}

	/**
	 * RPC method: Activate account.
	 * Emits #account + #identity + #sync per sync 1.1, so relays pick up
	 * the new state without polling. #sync is only emitted when a repo
	 * root exists (i.e. after migration import or initial commit).
	 */
	async rpcActivateAccount(): Promise<void> {
		const engine = await this.getEngine();
		await engine.activateAccount();
	}

	/**
	 * RPC method: Deactivate account.
	 * Emits #account(active=false, status='deactivated') per sync 1.1.
	 */
	async rpcDeactivateAccount(): Promise<void> {
		const engine = await this.getEngine();
		await engine.deactivateAccount();
	}

	// ============================================
	// Migration Progress RPC Methods
	// ============================================

	/**
	 * RPC method: Count blocks in storage
	 */
	async rpcCountBlocks(): Promise<number> {
		const storage = await this.getStorage();
		return storage.countBlocks();
	}

	/**
	 * RPC method: Count records in repository
	 */
	async rpcCountRecords(): Promise<number> {
		const engine = await this.getEngine();
		return engine.countRecords();
	}

	/**
	 * RPC method: Count expected blobs (referenced in records)
	 */
	async rpcCountExpectedBlobs(): Promise<number> {
		const storage = await this.getStorage();
		return storage.countExpectedBlobs();
	}

	/**
	 * RPC method: Count imported blobs
	 */
	async rpcCountImportedBlobs(): Promise<number> {
		const storage = await this.getStorage();
		return storage.countImportedBlobs();
	}

	/**
	 * RPC method: List missing blobs (referenced but not imported)
	 */
	async rpcListMissingBlobs(
		limit: number = 500,
		cursor?: string,
	): Promise<{
		blobs: Array<{ cid: string; recordUri: string }>;
		cursor?: string;
	}> {
		const storage = await this.getStorage();
		return storage.listMissingBlobs(limit, cursor);
	}

	/**
	 * RPC method: Reset migration state.
	 * Clears imported repo and blob tracking to allow re-import.
	 * Only works when account is deactivated.
	 */
	async rpcResetMigration(): Promise<{
		blocksDeleted: number;
		blobsCleared: number;
	}> {
		const engine = await this.getEngine();
		return engine.resetMigration();
	}

	/**
	 * Emit an identity event to notify downstream services to refresh identity cache.
	 * `handle` is optional per sync 1.1.
	 */
	async rpcEmitIdentityEvent(handle?: string): Promise<{ seq: number }> {
		const engine = await this.getEngine();
		return engine.emitIdentityEvent(handle);
	}

	// ============================================
	// Health Check RPC Methods
	// ============================================

	/**
	 * RPC method: Health check - verifies storage is accessible
	 */
	async rpcHealthCheck(): Promise<{ ok: true }> {
		this.ctx.storage.sql.exec("SELECT 1").toArray();
		return { ok: true };
	}

	/**
	 * RPC method: Firehose status - returns subscriber count and latest sequence
	 */
	async rpcGetFirehoseStatus(): Promise<{
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

	// ============================================
	// OAuth Storage RPC Methods
	// These methods proxy to SqliteOAuthStorage since we can't serialize the storage object
	// ============================================

	/** Save an authorization code */
	async rpcSaveAuthCode(
		code: string,
		data: import("@getcirrus/oauth-provider").AuthCodeData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveAuthCode(code, data);
	}

	/** Get authorization code data */
	async rpcGetAuthCode(
		code: string,
	): Promise<import("@getcirrus/oauth-provider").AuthCodeData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getAuthCode(code);
	}

	/** Delete an authorization code */
	async rpcDeleteAuthCode(code: string): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.deleteAuthCode(code);
	}

	/** Save token data */
	async rpcSaveTokens(
		data: import("@getcirrus/oauth-provider").TokenData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveTokens(data);
	}

	/** Get token data by access token */
	async rpcGetTokenByAccess(
		accessToken: string,
	): Promise<import("@getcirrus/oauth-provider").TokenData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getTokenByAccess(accessToken);
	}

	/** Get token data by refresh token */
	async rpcGetTokenByRefresh(
		refreshToken: string,
	): Promise<import("@getcirrus/oauth-provider").TokenData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getTokenByRefresh(refreshToken);
	}

	/** Revoke a token */
	async rpcRevokeToken(accessToken: string): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.revokeToken(accessToken);
	}

	/** Revoke all tokens for a user */
	async rpcRevokeAllTokens(sub: string): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.revokeAllTokens(sub);
	}

	/** Save client metadata */
	async rpcSaveClient(
		clientId: string,
		metadata: import("@getcirrus/oauth-provider").ClientMetadata,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveClient(clientId, metadata);
	}

	/** Get client metadata */
	async rpcGetClient(
		clientId: string,
	): Promise<import("@getcirrus/oauth-provider").ClientMetadata | null> {
		const storage = await this.getOAuthStorage();
		return storage.getClient(clientId);
	}

	/** Save PAR data */
	async rpcSavePAR(
		requestUri: string,
		data: import("@getcirrus/oauth-provider").PARData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.savePAR(requestUri, data);
	}

	/** Get PAR data */
	async rpcGetPAR(
		requestUri: string,
	): Promise<import("@getcirrus/oauth-provider").PARData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getPAR(requestUri);
	}

	/** Delete PAR data */
	async rpcDeletePAR(requestUri: string): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.deletePAR(requestUri);
	}

	/** Check and save DPoP nonce */
	async rpcCheckAndSaveNonce(nonce: string): Promise<boolean> {
		const storage = await this.getOAuthStorage();
		return storage.checkAndSaveNonce(nonce);
	}

	/**
	 * Look up a cached permission-set lexicon by NSID. Returns the cached
	 * value (with `stale: true` when past its 24h soft-expiry) or null when
	 * not cached or hard-expired.
	 */
	async rpcGetPermissionSet(
		nsid: string,
	): Promise<import("./oauth-storage.js").CachedPermissionSet | null> {
		const storage = await this.getOAuthStorage();
		return storage.getPermissionSet(nsid);
	}

	/** Cache a fetched permission-set lexicon. */
	async rpcSavePermissionSet(
		nsid: string,
		set: import("@getcirrus/oauth-provider").LexiconPermissionSet,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		storage.savePermissionSet(nsid, set);
	}

	// ============================================
	// Passkey RPC Methods
	// ============================================

	/** Save a passkey credential */
	async rpcSavePasskey(
		credentialId: string,
		publicKey: Uint8Array,
		counter: number,
		name?: string,
	): Promise<void> {
		const store = await this.getAccountStore();
		store.savePasskey(credentialId, publicKey, counter, name);
	}

	/** Get a passkey by credential ID */
	async rpcGetPasskey(credentialId: string): Promise<{
		credentialId: string;
		publicKey: Uint8Array;
		counter: number;
		name: string | null;
		createdAt: string;
		lastUsedAt: string | null;
	} | null> {
		const store = await this.getAccountStore();
		return store.getPasskey(credentialId);
	}

	/** List all passkeys */
	async rpcListPasskeys(): Promise<
		Array<{
			credentialId: string;
			name: string | null;
			createdAt: string;
			lastUsedAt: string | null;
		}>
	> {
		const store = await this.getAccountStore();
		return store.listPasskeys();
	}

	/** Delete a passkey */
	async rpcDeletePasskey(credentialId: string): Promise<boolean> {
		const store = await this.getAccountStore();
		return store.deletePasskey(credentialId);
	}

	/** Update passkey counter after authentication */
	async rpcUpdatePasskeyCounter(
		credentialId: string,
		counter: number,
	): Promise<void> {
		const store = await this.getAccountStore();
		store.updatePasskeyCounter(credentialId, counter);
	}

	/** Check if passkeys exist */
	async rpcHasPasskeys(): Promise<boolean> {
		const store = await this.getAccountStore();
		return store.hasPasskeys();
	}

	/** Save a registration token */
	async rpcSavePasskeyToken(
		token: string,
		challenge: string,
		expiresAt: number,
		name?: string,
	): Promise<void> {
		const store = await this.getAccountStore();
		store.savePasskeyToken(token, challenge, expiresAt, name);
	}

	/** Consume a registration token */
	async rpcConsumePasskeyToken(
		token: string,
	): Promise<{ challenge: string; name: string | null } | null> {
		const store = await this.getAccountStore();
		return store.consumePasskeyToken(token);
	}

	/** Save a WebAuthn challenge for passkey authentication */
	async rpcSaveWebAuthnChallenge(challenge: string): Promise<void> {
		const oauthStorage = await this.getOAuthStorage();
		oauthStorage.saveWebAuthnChallenge(challenge);
	}

	/** Consume a WebAuthn challenge (single-use) */
	async rpcConsumeWebAuthnChallenge(challenge: string): Promise<boolean> {
		const oauthStorage = await this.getOAuthStorage();
		return oauthStorage.consumeWebAuthnChallenge(challenge);
	}

	// ============================================
	// App Password RPC Methods
	// ============================================

	/** Save an app password (bcrypt hash) */
	async rpcSaveAppPassword(name: string, passwordHash: string): Promise<void> {
		const store = await this.getAccountStore();
		store.saveAppPassword(name, passwordHash);
	}

	/** List all app passwords (names and dates only) */
	async rpcListAppPasswords(): Promise<
		Array<{ name: string; createdAt: string }>
	> {
		const store = await this.getAccountStore();
		return store.listAppPasswords();
	}

	/** Delete an app password by name */
	async rpcDeleteAppPassword(name: string): Promise<boolean> {
		const store = await this.getAccountStore();
		return store.deleteAppPassword(name);
	}

	/** Get all app password hashes for login verification */
	async rpcGetAppPasswordHashes(): Promise<
		Array<{ name: string; passwordHash: string }>
	> {
		const store = await this.getAccountStore();
		return store.getAppPasswordHashes();
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
