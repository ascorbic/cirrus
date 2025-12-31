import { DurableObject } from "cloudflare:workers";
import {
	Repo,
	WriteOpAction,
	BlockMap,
	blocksToCarFile,
	readCarWithRoot,
	type RecordCreateOp,
	type RecordUpdateOp,
	type RecordDeleteOp,
	type RecordWriteOp,
} from "@atproto/repo";
import type { RepoRecord } from "@atproto/lexicon";
import { Secp256k1Keypair } from "@atproto/crypto";
import { CID } from "@atproto/lex-data";
import { TID } from "@atproto/common-web";
import { AtUri } from "@atproto/syntax";
import { encode as cborEncode } from "@atproto/lex-cbor";
import { SqliteRepoStorage } from "./storage";
import { SqliteOAuthStorage } from "./oauth-storage";
import { Sequencer, type SeqEvent, type CommitData } from "./sequencer";
import { BlobStore, type BlobRef } from "./blobs";
import type { PDSEnv } from "./types";

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
	private oauthStorage: SqliteOAuthStorage | null = null;
	private repo: Repo | null = null;
	private keypair: Secp256k1Keypair | null = null;
	private sequencer: Sequencer | null = null;
	private blobStore: BlobStore | null = null;
	private storageInitialized = false;
	private repoInitialized = false;

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
				this.oauthStorage = new SqliteOAuthStorage(this.ctx.storage.sql);
				this.oauthStorage.initSchema();
				this.sequencer = new Sequencer(this.ctx.storage.sql);
				this.storageInitialized = true;
			});
		}
	}

	/**
	 * Initialize the Repo instance. Called lazily on first repo access.
	 */
	private async ensureRepoInitialized(): Promise<void> {
		await this.ensureStorageInitialized();

		if (!this.repoInitialized) {
			await this.ctx.blockConcurrencyWhile(async () => {
				if (this.repoInitialized) return; // Double-check after acquiring lock

				// Load signing key
				this.keypair = await Secp256k1Keypair.import(this.env.SIGNING_KEY);

				// Load or create repo
				const root = await this.storage!.getRoot();
				if (root) {
					this.repo = await Repo.load(this.storage!, root);
				} else {
					this.repo = await Repo.create(
						this.storage!,
						this.env.DID,
						this.keypair,
					);
				}

				this.repoInitialized = true;
			});
		}
	}

	/**
	 * Get the storage adapter for direct access (used by tests and internal operations).
	 */
	async getStorage(): Promise<SqliteRepoStorage> {
		await this.ensureStorageInitialized();
		return this.storage!;
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
		await this.ensureRepoInitialized();
		return this.repo!;
	}

	/**
	 * Ensure the account is active. Throws error if deactivated.
	 */
	async ensureActive(): Promise<void> {
		const storage = await this.getStorage();
		const isActive = await storage.getActive();
		if (!isActive) {
			throw new Error(
				"AccountDeactivated: Account is deactivated. Call activateAccount to enable writes.",
			);
		}
	}

	/**
	 * Get the signing keypair for repository operations.
	 */
	async getKeypair(): Promise<Secp256k1Keypair> {
		await this.ensureRepoInitialized();
		return this.keypair!;
	}

	/**
	 * Update the Repo instance after mutations.
	 */
	async setRepo(repo: Repo): Promise<void> {
		this.repo = repo;
	}

	/**
	 * RPC method: Get repo metadata for describeRepo
	 */
	async rpcDescribeRepo(): Promise<{
		did: string;
		collections: string[];
		cid: string;
	}> {
		const repo = await this.getRepo();
		const collections: string[] = [];
		const seenCollections = new Set<string>();

		for await (const record of repo.walkRecords()) {
			if (!seenCollections.has(record.collection)) {
				seenCollections.add(record.collection);
				collections.push(record.collection);
			}
		}

		return {
			did: repo.did,
			collections,
			cid: repo.cid.toString(),
		};
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
		const repo = await this.getRepo();

		// Get the CID from the MST
		const dataKey = `${collection}/${rkey}`;
		const recordCid = await repo.data.get(dataKey);
		if (!recordCid) {
			return null;
		}

		const record = (await repo.getRecord(
			collection,
			rkey,
		)) as Rpc.Serializable<any>;

		if (!record) {
			return null;
		}

		return {
			cid: recordCid.toString(),
			record,
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
		const repo = await this.getRepo();
		const records = [];
		const startFrom = opts.cursor || `${collection}/`;

		for await (const record of repo.walkRecords(startFrom)) {
			if (record.collection !== collection) {
				if (records.length > 0) break;
				continue;
			}

			records.push({
				uri: AtUri.make(repo.did, record.collection, record.rkey).toString(),
				cid: record.cid.toString(),
				value: record.record,
			});

			if (records.length >= opts.limit + 1) break;
		}

		if (opts.reverse) {
			records.reverse();
		}

		const hasMore = records.length > opts.limit;
		const results = hasMore ? records.slice(0, opts.limit) : records;
		const cursor = hasMore
			? `${collection}/${results[results.length - 1]?.uri.split("/").pop() ?? ""}`
			: undefined;

		return { records: results, cursor };
	}

	/**
	 * RPC method: Create a record
	 */
	async rpcCreateRecord(
		collection: string,
		rkey: string | undefined,
		record: unknown,
	): Promise<{
		uri: string;
		cid: string;
		commit: { cid: string; rev: string };
	}> {
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const actualRkey = rkey || TID.nextStr();
		const createOp: RecordCreateOp = {
			action: WriteOpAction.Create,
			collection,
			rkey: actualRkey,
			record: record as RepoRecord,
		};

		const prevRev = repo.commit.rev;
		const updatedRepo = await repo.applyWrites([createOp], keypair);
		this.repo = updatedRepo;

		// Get the CID for the created record from the MST
		const dataKey = `${collection}/${actualRkey}`;
		const recordCid = await this.repo.data.get(dataKey);

		if (!recordCid) {
			throw new Error(`Failed to create record: ${collection}/${actualRkey}`);
		}

		// Sequence the commit for firehose
		if (this.sequencer) {
			// Get blocks that changed
			const newBlocks = new BlockMap();
			const rows = this.ctx.storage.sql
				.exec(
					"SELECT cid, bytes FROM blocks WHERE rev = ?",
					this.repo.commit.rev,
				)
				.toArray();

			for (const row of rows) {
				const cid = CID.parse(row.cid as string);
				const bytes = new Uint8Array(row.bytes as ArrayBuffer);
				newBlocks.set(cid, bytes);
			}

			// Include the record CID in the op for the firehose
			const opWithCid = { ...createOp, cid: recordCid };

			const commitData: CommitData = {
				did: this.repo.did,
				commit: this.repo.cid,
				rev: this.repo.commit.rev,
				since: prevRev,
				newBlocks,
				ops: [opWithCid],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcastCommit(event);
		}

		return {
			uri: AtUri.make(this.repo.did, collection, actualRkey).toString(),
			cid: recordCid.toString(),
			commit: {
				cid: this.repo.cid.toString(),
				rev: this.repo.commit.rev,
			},
		};
	}

	/**
	 * RPC method: Delete a record
	 */
	async rpcDeleteRecord(
		collection: string,
		rkey: string,
	): Promise<{ commit: { cid: string; rev: string } } | null> {
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const existing = await repo.getRecord(collection, rkey);
		if (!existing) return null;

		const deleteOp: RecordDeleteOp = {
			action: WriteOpAction.Delete,
			collection,
			rkey,
		};

		const prevRev = repo.commit.rev;
		const updatedRepo = await repo.applyWrites([deleteOp], keypair);
		this.repo = updatedRepo;

		// Sequence the commit for firehose
		if (this.sequencer) {
			// Get blocks that changed
			const newBlocks = new BlockMap();
			const rows = this.ctx.storage.sql
				.exec(
					"SELECT cid, bytes FROM blocks WHERE rev = ?",
					this.repo.commit.rev,
				)
				.toArray();

			for (const row of rows) {
				const cid = CID.parse(row.cid as string);
				const bytes = new Uint8Array(row.bytes as ArrayBuffer);
				newBlocks.set(cid, bytes);
			}

			const commitData: CommitData = {
				did: this.repo.did,
				commit: this.repo.cid,
				rev: this.repo.commit.rev,
				since: prevRev,
				newBlocks,
				ops: [deleteOp],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcastCommit(event);
		}

		return {
			commit: {
				cid: updatedRepo.cid.toString(),
				rev: updatedRepo.commit.rev,
			},
		};
	}

	/**
	 * RPC method: Put a record (create or update)
	 */
	async rpcPutRecord(
		collection: string,
		rkey: string,
		record: unknown,
	): Promise<{
		uri: string;
		cid: string;
		commit: { cid: string; rev: string };
		validationStatus: string;
	}> {
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		// Check if record exists to determine create vs update
		const existing = await repo.getRecord(collection, rkey);
		const isUpdate = existing !== null;

		const op: RecordWriteOp = isUpdate
			? ({
					action: WriteOpAction.Update,
					collection,
					rkey,
					record: record as RepoRecord,
				} as RecordUpdateOp)
			: ({
					action: WriteOpAction.Create,
					collection,
					rkey,
					record: record as RepoRecord,
				} as RecordCreateOp);

		const prevRev = repo.commit.rev;
		const updatedRepo = await repo.applyWrites([op], keypair);
		this.repo = updatedRepo;

		// Get the CID for the record from the MST
		const dataKey = `${collection}/${rkey}`;
		const recordCid = await this.repo.data.get(dataKey);

		if (!recordCid) {
			throw new Error(`Failed to put record: ${collection}/${rkey}`);
		}

		// Sequence the commit for firehose
		if (this.sequencer) {
			const newBlocks = new BlockMap();
			const rows = this.ctx.storage.sql
				.exec(
					"SELECT cid, bytes FROM blocks WHERE rev = ?",
					this.repo.commit.rev,
				)
				.toArray();

			for (const row of rows) {
				const cid = CID.parse(row.cid as string);
				const bytes = new Uint8Array(row.bytes as ArrayBuffer);
				newBlocks.set(cid, bytes);
			}

			const opWithCid = { ...op, cid: recordCid };

			const commitData: CommitData = {
				did: this.repo.did,
				commit: this.repo.cid,
				rev: this.repo.commit.rev,
				since: prevRev,
				newBlocks,
				ops: [opWithCid],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcastCommit(event);
		}

		return {
			uri: AtUri.make(this.repo.did, collection, rkey).toString(),
			cid: recordCid.toString(),
			commit: {
				cid: this.repo.cid.toString(),
				rev: this.repo.commit.rev,
			},
			validationStatus: "valid",
		};
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
		}>,
	): Promise<{
		commit: { cid: string; rev: string };
		results: Array<{
			$type: string;
			uri?: string;
			cid?: string;
			validationStatus?: string;
		}>;
	}> {
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		// Convert input writes to RecordWriteOp format
		const ops: RecordWriteOp[] = [];
		const results: Array<{
			$type: string;
			uri?: string;
			cid?: string;
			validationStatus?: string;
			collection: string;
			rkey: string;
			action: WriteOpAction;
		}> = [];

		for (const write of writes) {
			if (write.$type === "com.atproto.repo.applyWrites#create") {
				const rkey = write.rkey || TID.nextStr();
				const op: RecordCreateOp = {
					action: WriteOpAction.Create,
					collection: write.collection,
					rkey,
					record: write.value as RepoRecord,
				};
				ops.push(op);
				results.push({
					$type: "com.atproto.repo.applyWrites#createResult",
					collection: write.collection,
					rkey,
					action: WriteOpAction.Create,
				});
			} else if (write.$type === "com.atproto.repo.applyWrites#update") {
				if (!write.rkey) {
					throw new Error("Update requires rkey");
				}
				const op: RecordUpdateOp = {
					action: WriteOpAction.Update,
					collection: write.collection,
					rkey: write.rkey,
					record: write.value as RepoRecord,
				};
				ops.push(op);
				results.push({
					$type: "com.atproto.repo.applyWrites#updateResult",
					collection: write.collection,
					rkey: write.rkey,
					action: WriteOpAction.Update,
				});
			} else if (write.$type === "com.atproto.repo.applyWrites#delete") {
				if (!write.rkey) {
					throw new Error("Delete requires rkey");
				}
				const op: RecordDeleteOp = {
					action: WriteOpAction.Delete,
					collection: write.collection,
					rkey: write.rkey,
				};
				ops.push(op);
				results.push({
					$type: "com.atproto.repo.applyWrites#deleteResult",
					collection: write.collection,
					rkey: write.rkey,
					action: WriteOpAction.Delete,
				});
			} else {
				throw new Error(`Unknown write type: ${write.$type}`);
			}
		}

		const prevRev = repo.commit.rev;
		const updatedRepo = await repo.applyWrites(ops, keypair);
		this.repo = updatedRepo;

		// Build final results with CIDs and prepare ops with CIDs for firehose
		const finalResults: Array<{
			$type: string;
			uri?: string;
			cid?: string;
			validationStatus?: string;
		}> = [];
		const opsWithCids: Array<RecordWriteOp & { cid?: CID | null }> = [];

		for (let i = 0; i < results.length; i++) {
			const result = results[i]!;
			const op = ops[i]!;

			if (result.action === WriteOpAction.Delete) {
				finalResults.push({
					$type: result.$type,
				});
				opsWithCids.push(op);
			} else {
				// Get the CID for create/update
				const dataKey = `${result.collection}/${result.rkey}`;
				const recordCid = await this.repo.data.get(dataKey);
				finalResults.push({
					$type: result.$type,
					uri: AtUri.make(
						this.repo.did,
						result.collection,
						result.rkey,
					).toString(),
					cid: recordCid?.toString(),
					validationStatus: "valid",
				});
				// Include the record CID in the op for the firehose
				opsWithCids.push({ ...op, cid: recordCid });
			}
		}

		// Sequence the commit for firehose
		if (this.sequencer) {
			const newBlocks = new BlockMap();
			const rows = this.ctx.storage.sql
				.exec(
					"SELECT cid, bytes FROM blocks WHERE rev = ?",
					this.repo.commit.rev,
				)
				.toArray();

			for (const row of rows) {
				const cid = CID.parse(row.cid as string);
				const bytes = new Uint8Array(row.bytes as ArrayBuffer);
				newBlocks.set(cid, bytes);
			}

			const commitData: CommitData = {
				did: this.repo.did,
				commit: this.repo.cid,
				rev: this.repo.commit.rev,
				since: prevRev,
				newBlocks,
				ops: opsWithCids,
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcastCommit(event);
		}

		return {
			commit: {
				cid: this.repo.cid.toString(),
				rev: this.repo.commit.rev,
			},
			results: finalResults,
		};
	}

	/**
	 * RPC method: Get repo status
	 */
	async rpcGetRepoStatus(): Promise<{
		did: string;
		head: string;
		rev: string;
	}> {
		const repo = await this.getRepo();
		return {
			did: repo.did,
			head: repo.cid.toString(),
			rev: repo.commit.rev,
		};
	}

	/**
	 * RPC method: Export repo as CAR
	 */
	async rpcGetRepoCar(): Promise<Uint8Array> {
		const storage = await this.getStorage();
		const root = await storage.getRoot();

		if (!root) {
			throw new Error("No repository root found");
		}

		// Get all blocks from SQLite storage
		const rows = this.ctx.storage.sql
			.exec("SELECT cid, bytes FROM blocks")
			.toArray();

		// Build BlockMap
		const blocks = new BlockMap();
		for (const row of rows) {
			const cid = CID.parse(row.cid as string);
			const bytes = new Uint8Array(row.bytes as ArrayBuffer);
			blocks.set(cid, bytes);
		}

		// Use the official CAR builder
		return blocksToCarFile(root, blocks);
	}

	/**
	 * RPC method: Get specific blocks by CID as CAR file
	 * Used for partial sync and migration.
	 */
	async rpcGetBlocks(cids: string[]): Promise<Uint8Array> {
		const storage = await this.getStorage();
		const root = await storage.getRoot();

		if (!root) {
			throw new Error("No repository root found");
		}

		// Get requested blocks
		const blocks = new BlockMap();
		for (const cidStr of cids) {
			const cid = CID.parse(cidStr);
			const bytes = await storage.getBytes(cid);
			if (bytes) {
				blocks.set(cid, bytes);
			}
		}

		// Return CAR file with requested blocks
		return blocksToCarFile(root, blocks);
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
		await this.ensureStorageInitialized();

		// Check if repo already exists
		const existingRoot = await this.storage!.getRoot();
		if (existingRoot) {
			throw new Error(
				"Repository already exists. Cannot import over existing repository.",
			);
		}

		// Use official @atproto/repo utilities to read and validate CAR
		// readCarWithRoot validates single root requirement and returns BlockMap
		const { root: rootCid, blocks } = await readCarWithRoot(carBytes);

		// Import all blocks into storage using putMany (more efficient than individual putBlock)
		const importRev = TID.nextStr();
		await this.storage!.putMany(blocks, importRev);

		// Load the repo to verify it's valid and get the actual revision
		this.keypair = await Secp256k1Keypair.import(this.env.SIGNING_KEY);
		this.repo = await Repo.load(this.storage!, rootCid);

		// Verify the DID matches to prevent incorrect migrations
		if (this.repo.did !== this.env.DID) {
			// Clean up imported blocks
			await this.storage!.destroy();
			throw new Error(
				`DID mismatch: CAR file contains DID ${this.repo.did}, but expected ${this.env.DID}`,
			);
		}

		this.repoInitialized = true;

		// Extract blob references from all imported records for tracking
		for await (const record of this.repo.walkRecords()) {
			const blobCids = extractBlobCids(record.record);
			if (blobCids.length > 0) {
				const uri = AtUri.make(
					this.repo.did,
					record.collection,
					record.rkey,
				).toString();
				this.storage!.addRecordBlobs(uri, blobCids);
			}
		}

		return {
			did: this.repo.did,
			rev: this.repo.commit.rev,
			cid: rootCid.toString(),
		};
	}

	/**
	 * RPC method: Upload a blob to R2
	 */
	async rpcUploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		if (!this.blobStore) {
			throw new Error("Blob storage not configured");
		}

		// Enforce size limit (5MB)
		const MAX_BLOB_SIZE = 5 * 1024 * 1024;
		if (bytes.length > MAX_BLOB_SIZE) {
			throw new Error(
				`Blob too large: ${bytes.length} bytes (max ${MAX_BLOB_SIZE})`,
			);
		}

		const blobRef = await this.blobStore.putBlob(bytes, mimeType);

		// Track the imported blob for migration progress
		const storage = await this.getStorage();
		storage.trackImportedBlob(blobRef.ref.$link, bytes.length, mimeType);

		return blobRef;
	}

	/**
	 * RPC method: Get a blob from R2
	 */
	async rpcGetBlob(cidStr: string): Promise<R2ObjectBody | null> {
		if (!this.blobStore) {
			throw new Error("Blob storage not configured");
		}

		const cid = CID.parse(cidStr);
		return this.blobStore.getBlob(cid);
	}

	/**
	 * Encode a firehose frame (header + body CBOR).
	 */
	private encodeFrame(header: object, body: object): Uint8Array {
		const headerBytes = cborEncode(header as any);
		const bodyBytes = cborEncode(body as any);

		const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
		frame.set(headerBytes, 0);
		frame.set(bodyBytes, headerBytes.length);

		return frame;
	}

	/**
	 * Encode a commit event frame.
	 */
	private encodeCommitFrame(event: SeqEvent): Uint8Array {
		const header = { op: 1, t: "#commit" };
		return this.encodeFrame(header, event.event);
	}

	/**
	 * Encode an error frame.
	 */
	private encodeErrorFrame(error: string, message: string): Uint8Array {
		const header = { op: -1 };
		const body = { error, message };
		return this.encodeFrame(header, body);
	}

	/**
	 * Backfill firehose events from a cursor.
	 */
	private async backfillFirehose(ws: WebSocket, cursor: number): Promise<void> {
		if (!this.sequencer) {
			throw new Error("Sequencer not initialized");
		}

		const latestSeq = this.sequencer.getLatestSeq();

		// Check if cursor is in the future
		if (cursor > latestSeq) {
			const frame = this.encodeErrorFrame(
				"FutureCursor",
				"Cursor is in the future",
			);
			ws.send(frame);
			ws.close(1008, "FutureCursor");
			return;
		}

		// Backfill from cursor
		const events = await this.sequencer.getEventsSince(cursor, 1000);

		for (const event of events) {
			const frame = this.encodeCommitFrame(event);
			ws.send(frame);
		}

		// Update cursor in attachment
		if (events.length > 0) {
			const lastEvent = events[events.length - 1];
			if (lastEvent) {
				const attachment = ws.deserializeAttachment() as { cursor: number };
				attachment.cursor = lastEvent.seq;
				ws.serializeAttachment(attachment);
			}
		}
	}

	/**
	 * Broadcast a commit event to all connected firehose clients.
	 */
	private async broadcastCommit(event: SeqEvent): Promise<void> {
		const frame = this.encodeCommitFrame(event);

		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(frame);

				// Update cursor
				const attachment = ws.deserializeAttachment() as { cursor: number };
				attachment.cursor = event.seq;
				ws.serializeAttachment(attachment);
			} catch (e) {
				// Client disconnected, will be cleaned up
				console.error("Error broadcasting to WebSocket:", e);
			}
		}
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

		// Store cursor in attachment
		server.serializeAttachment({
			cursor: cursor ?? 0,
			connectedAt: Date.now(),
		});

		// Backfill if cursor provided
		if (cursor !== null) {
			await this.backfillFirehose(server, cursor);
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
		const storage = await this.getStorage();
		const preferences = await storage.getPreferences();
		return { preferences };
	}

	/**
	 * RPC method: Put user preferences
	 */
	async rpcPutPreferences(preferences: unknown[]): Promise<void> {
		const storage = await this.getStorage();
		await storage.putPreferences(preferences);
	}

	/**
	 * RPC method: Get account activation state
	 */
	async rpcGetActive(): Promise<boolean> {
		const storage = await this.getStorage();
		return storage.getActive();
	}

	/**
	 * RPC method: Activate account
	 */
	async rpcActivateAccount(): Promise<void> {
		const storage = await this.getStorage();
		await storage.setActive(true);
	}

	/**
	 * RPC method: Deactivate account
	 */
	async rpcDeactivateAccount(): Promise<void> {
		const storage = await this.getStorage();
		await storage.setActive(false);
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
		const repo = await this.getRepo();
		let count = 0;
		for await (const _record of repo.walkRecords()) {
			count++;
		}
		return count;
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
	): Promise<{ blobs: Array<{ cid: string; recordUri: string }>; cursor?: string }> {
		const storage = await this.getStorage();
		return storage.listMissingBlobs(limit, cursor);
	}

	/**
	 * Emit an identity event to notify downstream services to refresh identity cache.
	 */
	async rpcEmitIdentityEvent(handle: string): Promise<{ seq: number }> {
		await this.ensureStorageInitialized();

		const time = new Date().toISOString();

		// Get next sequence number
		const result = this.ctx.storage.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
				 VALUES ('identity', ?)
				 RETURNING seq`,
				new Uint8Array(0), // Empty payload, we just need seq
			)
			.one();
		const seq = result.seq as number;

		// Build identity event frame
		const header = { op: 1, t: "#identity" };
		const body = {
			seq,
			did: this.env.DID,
			time,
			handle,
		};

		const headerBytes = cborEncode(
			header as unknown as import("@atproto/lex-cbor").LexValue,
		);
		const bodyBytes = cborEncode(
			body as unknown as import("@atproto/lex-cbor").LexValue,
		);
		const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
		frame.set(headerBytes, 0);
		frame.set(bodyBytes, headerBytes.length);

		// Broadcast to all connected clients
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(frame);
			} catch (e) {
				console.error("Error broadcasting identity event:", e);
			}
		}

		return { seq };
	}

	// ============================================
	// OAuth Storage RPC Methods
	// These methods proxy to SqliteOAuthStorage since we can't serialize the storage object
	// ============================================

	/** Save an authorization code */
	async rpcSaveAuthCode(
		code: string,
		data: import("@ascorbic/atproto-oauth-provider").AuthCodeData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveAuthCode(code, data);
	}

	/** Get authorization code data */
	async rpcGetAuthCode(
		code: string,
	): Promise<import("@ascorbic/atproto-oauth-provider").AuthCodeData | null> {
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
		data: import("@ascorbic/atproto-oauth-provider").TokenData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveTokens(data);
	}

	/** Get token data by access token */
	async rpcGetTokenByAccess(
		accessToken: string,
	): Promise<import("@ascorbic/atproto-oauth-provider").TokenData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getTokenByAccess(accessToken);
	}

	/** Get token data by refresh token */
	async rpcGetTokenByRefresh(
		refreshToken: string,
	): Promise<import("@ascorbic/atproto-oauth-provider").TokenData | null> {
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
		metadata: import("@ascorbic/atproto-oauth-provider").ClientMetadata,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveClient(clientId, metadata);
	}

	/** Get client metadata */
	async rpcGetClient(
		clientId: string,
	): Promise<import("@ascorbic/atproto-oauth-provider").ClientMetadata | null> {
		const storage = await this.getOAuthStorage();
		return storage.getClient(clientId);
	}

	/** Save PAR data */
	async rpcSavePAR(
		requestUri: string,
		data: import("@ascorbic/atproto-oauth-provider").PARData,
	): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.savePAR(requestUri, data);
	}

	/** Get PAR data */
	async rpcGetPAR(
		requestUri: string,
	): Promise<import("@ascorbic/atproto-oauth-provider").PARData | null> {
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
	 * HTTP fetch handler for WebSocket upgrades.
	 * This is used instead of RPC to avoid WebSocket serialization errors.
	 */
	override async fetch(request: Request): Promise<Response> {
		// Only handle WebSocket upgrades via fetch
		const url = new URL(request.url);
		if (url.pathname === "/xrpc/com.atproto.sync.subscribeRepos") {
			return this.handleFirehoseUpgrade(request);
		}

		// All other requests should use RPC methods, not fetch
		return new Response("Method not allowed", { status: 405 });
	}
}

/**
 * Extract blob CIDs from a record by recursively searching for blob references.
 * Blob refs have the structure: { $type: "blob", ref: { $link: "..." }, mimeType, size }
 */
function extractBlobCids(obj: unknown): string[] {
	const cids: string[] = [];

	function walk(value: unknown): void {
		if (value === null || value === undefined) return;

		if (typeof value === "object") {
			const record = value as Record<string, unknown>;

			// Check if this is a blob reference
			if (
				record.$type === "blob" &&
				record.ref &&
				typeof record.ref === "object"
			) {
				const ref = record.ref as Record<string, unknown>;
				if (typeof ref.$link === "string") {
					cids.push(ref.$link);
				}
			}

			// Recursively walk all properties
			for (const key of Object.keys(record)) {
				walk(record[key]);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				walk(item);
			}
		}
	}

	walk(obj);
	return cids;
}
