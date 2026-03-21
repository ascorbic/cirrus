import { DurableObject } from "cloudflare:workers";
import {
	Repo,
	WriteOpAction,
	BlockMap,
	blocksToCarFile,
	writeCarStream,
	readCarWithRoot,
	getRecords,
	type CarBlock,
	type RecordCreateOp,
	type RecordUpdateOp,
	type RecordDeleteOp,
	type RecordWriteOp,
} from "@atproto/repo";
import type {
	AuthCodeData,
	ClientMetadata,
	PARData,
	TokenData,
} from "@fidis/oauth-provider";
/** Record type compatible with @atproto/repo operations */
type RepoRecord = Record<string, unknown>;
import { Secp256k1Keypair } from "@atproto/crypto";
import { CID, asCid, isBlobRef } from "@atproto/lex-data";
import { now as tidNow } from "@atcute/tid";
import { encode as cborEncode } from "./cbor-compat";
import { SqliteRepoStorage } from "./storage";
import { SqliteOAuthStorage } from "./oauth-storage";
import {
	Sequencer,
	type SeqEvent,
	type SeqCommitEvent,
	type SeqIdentityEvent,
	type CommitData,
} from "./sequencer";
import { BlobStore, type BlobRef } from "./blobs";
import { jsonToLex } from "@atproto/lex-json";
import type { PDSEnv, AtprotoIdentity } from "./types";

/**
 * Account Durable Object - manages a single user's AT Protocol repository.
 *
 * This DO provides:
 * - SQLite-backed block storage for the repository
 * - AT Protocol Repo instance for repository operations
 * - Firehose WebSocket connections
 * - Sequence number management
 *
 * Identity (DID, handle, signing keys) is stored in the SQLite atproto_identity table.
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
	/** Cached identity */
	private cachedIdentity: AtprotoIdentity | null = null;

	constructor(ctx: DurableObjectState, env: PDSEnv) {
		super(ctx, env);
		// BlobStore is initialized lazily after identity is loaded
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
		if (this.storage) {
			this.storage.cleanupPasskeyTokens();
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
	 * Initialize the Repo instance. Called lazily on first repo access.
	 * Identity is loaded from the SQLite atproto_identity table.
	 */
	private async ensureRepoInitialized(): Promise<void> {
		await this.ensureStorageInitialized();

		if (!this.repoInitialized) {
			await this.ctx.blockConcurrencyWhile(async () => {
				if (this.repoInitialized) return; // Double-check after acquiring lock

				// Load identity from database
				const identity = this.storage!.getAtprotoIdentity();
				if (!identity) {
					throw new Error(
						"No identity found. Account must be created first via is.fid.account.create",
					);
				}
				this.cachedIdentity = identity;

				// Initialize BlobStore with stored DID if not already done
				if (!this.blobStore && this.env.BLOBS) {
					this.blobStore = new BlobStore(this.env.BLOBS, identity.did);
				}

				// Load signing key
				this.keypair = await Secp256k1Keypair.import(identity.signingKey);

				// Load or create repo
				const root = await this.storage!.getRoot();
				if (root) {
					this.repo = await Repo.load(this.storage!, root);
				} else {
					this.repo = await Repo.create(this.storage!, identity.did, this.keypair);
				}

				this.repoInitialized = true;
			});
		}
	}

	/**
	 * Get the DID for this account from cached identity.
	 */
	private getAccountDid(): string {
		if (this.cachedIdentity) {
			return this.cachedIdentity.did;
		}
		throw new Error("No DID available - identity not loaded");
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
		const storage = await this.getStorage();

		// Lazy backfill: if the cache is empty and the repo has content, populate it
		if (!storage.hasCollections() && (await storage.getRoot())) {
			const seen = new Set<string>();
			for await (const record of repo.walkRecords()) {
				if (!seen.has(record.collection)) {
					seen.add(record.collection);
					storage.addCollection(record.collection);
				}
			}
		}

		return {
			did: repo.did,
			collections: storage.getCollections(),
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

		const record = await repo.getRecord(collection, rkey);

		if (!record) {
			return null;
		}

		return {
			cid: recordCid.toString(),
			record: serializeRecord(record) as Rpc.Serializable<any>,
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
				uri: `at://${repo.did}/${record.collection}/${record.rkey}`,
				cid: record.cid.toString(),
				value: serializeRecord(record.record),
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

		const actualRkey = rkey || tidNow();
		const createOp: RecordCreateOp = {
			action: WriteOpAction.Create,
			collection,
			rkey: actualRkey,
			record: jsonToLex(record) as RepoRecord,
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

		// Update collections cache
		this.storage!.addCollection(collection);

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
			uri: `at://${this.repo.did}/${collection}/${actualRkey}`,
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

		const normalizedRecord = jsonToLex(record) as RepoRecord;
		const op: RecordWriteOp = isUpdate
			? ({
					action: WriteOpAction.Update,
					collection,
					rkey,
					record: normalizedRecord,
				} as RecordUpdateOp)
			: ({
					action: WriteOpAction.Create,
					collection,
					rkey,
					record: normalizedRecord,
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

		// Update collections cache
		this.storage!.addCollection(collection);

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
			uri: `at://${this.repo.did}/${collection}/${rkey}`,
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
				const rkey = write.rkey || tidNow();
				const op: RecordCreateOp = {
					action: WriteOpAction.Create,
					collection: write.collection,
					rkey,
					record: jsonToLex(write.value) as RepoRecord,
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
					record: jsonToLex(write.value) as RepoRecord,
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

		// Update collections cache for create/update ops
		for (const op of ops) {
			if (op.action !== WriteOpAction.Delete) {
				this.storage!.addCollection(op.collection);
			}
		}

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
					uri: `at://${this.repo.did}/${result.collection}/${result.rkey}`,
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
	 * RPC method: Get repo status including lifecycle state.
	 */
	async rpcGetRepoStatus(): Promise<{
		did: string;
		head: string;
		rev: string;
		active: boolean;
		status: string;
	}> {
		const storage = await this.getStorage();
		const status = storage.getStatus();
		const did = storage.getAtprotoDid();

		// No identity: either never created or legacy-deleted (old deleteAll)
		if (!did) {
			return {
				did: "",
				head: "",
				rev: "",
				active: false,
				status: "deleted",
			};
		}

		// Deleted accounts have no repo (keys and blocks cleared)
		if (status === "deleted") {
			return {
				did,
				head: "",
				rev: "",
				active: false,
				status: "deleted",
			};
		}

		const repo = await this.getRepo();
		return {
			did: repo.did,
			head: repo.cid.toString(),
			rev: repo.commit.rev,
			active: status === "active",
			status,
		};
	}

	/**
	 * Handle streaming getRepo via fetch (not RPC, to enable streaming response).
	 */
	private async handleGetRepo(): Promise<Response> {
		const storage = await this.getStorage();
		const root = await storage.getRoot();

		if (!root) {
			return Response.json(
				{ error: "RepoNotFound", message: "No repository root found" },
				{ status: 404 },
			);
		}

		// Lazily iterate SQLite rows — the cursor is already lazy,
		// only .toArray() would materialize everything in memory.
		const cursor = this.ctx.storage.sql.exec(
			"SELECT cid, bytes FROM blocks",
		);

		async function* blocks(): AsyncGenerator<CarBlock> {
			for (const row of cursor) {
				yield {
					cid: CID.parse(row.cid as string),
					bytes: new Uint8Array(row.bytes as ArrayBuffer),
				};
			}
		}

		const carIter = writeCarStream(root, blocks())[Symbol.asyncIterator]();

		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { value, done } = await carIter.next();
				if (done) {
					controller.close();
				} else {
					controller.enqueue(value);
				}
			},
		});

		return new Response(stream, {
			headers: { "Content-Type": "application/vnd.ipld.car" },
		});
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
	 * RPC method: Get record with proof as CAR file.
	 * Returns the commit block and all MST blocks needed to verify
	 * the existence (or non-existence) of a record.
	 * Used by com.atproto.sync.getRecord for record verification.
	 */
	async rpcGetRecordProof(
		collection: string,
		rkey: string,
	): Promise<Uint8Array> {
		const storage = await this.getStorage();
		const root = await storage.getRoot();

		if (!root) {
			throw new Error("No repository root found");
		}

		// Use @atproto/repo's getRecords to generate the proof CAR
		// This returns an async iterable of CAR chunks
		const carChunks: Uint8Array[] = [];
		for await (const chunk of getRecords(storage, root, [
			{ collection, rkey },
		])) {
			carChunks.push(chunk);
		}

		// Concatenate all chunks into a single Uint8Array
		const totalLength = carChunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of carChunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}

		return result;
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

		// Check if account is active - only allow imports on deactivated accounts
		const isActive = await this.storage!.getActive();
		const existingRoot = await this.storage!.getRoot();

		if (isActive && existingRoot) {
			// Account is active - reject import to prevent accidental overwrites
			throw new Error(
				"Repository already exists. Cannot import over existing repository.",
			);
		}

		// If deactivated and repo exists, clear it first
		if (existingRoot) {
			await this.storage!.destroy();
			this.repo = null;
			this.repoInitialized = false;
		}

		// Use official @atproto/repo utilities to read and validate CAR
		// readCarWithRoot validates single root requirement and returns BlockMap
		const { root: rootCid, blocks } = await readCarWithRoot(carBytes);

		// Import all blocks into storage using putMany (more efficient than individual putBlock)
		const importRev = tidNow();
		await this.storage!.putMany(blocks, importRev);

		// Get signing key and expected DID from stored identity
		const identity = this.storage!.getAtprotoIdentity();
		if (!identity) {
			throw new Error("No identity found for import validation");
		}
		const signingKey = identity.signingKey;
		const expectedDid = identity.did;

		// Load the repo to verify it's valid and get the actual revision
		this.keypair = await Secp256k1Keypair.import(signingKey);
		this.repo = await Repo.load(this.storage!, rootCid);

		// Persist the root CID in storage so getRoot() works correctly
		await this.storage!.updateRoot(rootCid, this.repo.commit.rev);

		// Verify the DID matches to prevent incorrect migrations
		if (this.repo.did !== expectedDid) {
			// Clean up imported blocks
			await this.storage!.destroy();
			throw new Error(
				`DID mismatch: CAR file contains DID ${this.repo.did}, but expected ${expectedDid}`,
			);
		}

		this.repoInitialized = true;

		// Extract blob references and collection names from all imported records
		const seenCollections = new Set<string>();
		for await (const record of this.repo.walkRecords()) {
			if (!seenCollections.has(record.collection)) {
				seenCollections.add(record.collection);
				this.storage!.addCollection(record.collection);
			}
			const blobCids = extractBlobCids(record.record);
			if (blobCids.length > 0) {
				const uri = `at://${this.repo.did}/${record.collection}/${record.rkey}`;
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
		await this.ensureRepoInitialized();
		if (!this.blobStore) {
			throw new Error("Blob storage not configured");
		}

		// Enforce size limit (60MB)
		const MAX_BLOB_SIZE = 60 * 1024 * 1024;
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
		return this.blobStore.getBlob(cidStr);
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
	private encodeCommitFrame(event: SeqCommitEvent): Uint8Array {
		const header = { op: 1, t: "#commit" };
		return this.encodeFrame(header, event.event);
	}

	/**
	 * Encode an identity event frame.
	 */
	private encodeIdentityFrame(event: SeqIdentityEvent): Uint8Array {
		const header = { op: 1, t: "#identity" };
		return this.encodeFrame(header, event.event);
	}

	/**
	 * Encode any event frame based on its type.
	 */
	private encodeEventFrame(event: SeqEvent): Uint8Array {
		if (event.type === "identity") {
			return this.encodeIdentityFrame(event);
		}
		return this.encodeCommitFrame(event);
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
			const frame = this.encodeEventFrame(event);
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
		const frame = this.encodeEventFrame(event);

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

		// If the account is deleted or never created, return a non-WebSocket
		// error. TODO: implement proper #account tombstone over WebSocket.
		if (
			!this.storage!.hasAtprotoIdentity() ||
			this.storage!.getStatus() === "deleted"
		) {
			return new Response(
				JSON.stringify({ error: "AccountNotFound", message: "Account deleted" }),
				{ status: 410, headers: { "Content-Type": "application/json" } },
			);
		}

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
	 * Send a tombstone #account event over WebSocket, then close.
	 * Used for deleted or never-created accounts.
	 */
	private sendFirehoseTombstone(request: Request): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// Use stored DID if available, otherwise derive from hostname
		let did = this.storage?.getAtprotoDid();
		if (!did) {
			const url = new URL(request.url);
			did = `did:web:${url.hostname}`;
		}

		// Build tombstone frame
		const header = { op: 1, t: "#account" };
		const body = {
			seq: 0,
			did,
			time: new Date().toISOString(),
			active: false,
			status: "deleted",
		};
		const headerBytes = cborEncode(header as any);
		const bodyBytes = cborEncode(body as any);
		const tombstoneFrame = new Uint8Array(headerBytes.length + bodyBytes.length);
		tombstoneFrame.set(headerBytes, 0);
		tombstoneFrame.set(bodyBytes, headerBytes.length);

		// Use raw accept() instead of hibernation API — we just need to
		// send one frame and close, no need for hibernation lifecycle.
		server.accept();
		server.send(tombstoneFrame);
		server.close(1000, "AccountDeleted");

		return new Response(null, { status: 101, webSocket: client });
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
	 * RPC method: Get stored email
	 */
	async rpcGetEmail(): Promise<{ email: string | null }> {
		const storage = await this.getStorage();
		return { email: storage.getEmail() };
	}

	/**
	 * RPC method: Update stored email
	 */
	async rpcUpdateEmail(email: string): Promise<void> {
		const storage = await this.getStorage();
		storage.setEmail(email);
	}

	/**
	 * RPC method: Activate account
	 */
	async rpcActivateAccount(): Promise<void> {
		const storage = await this.getStorage();
		storage.setStatus("active");
		await this.rpcEmitAccountEvent(true);
	}

	/**
	 * RPC method: Deactivate account
	 */
	async rpcDeactivateAccount(): Promise<void> {
		const storage = await this.getStorage();
		storage.setStatus("deactivated");
		await this.rpcEmitAccountEvent(false, "deactivated");
	}

	/**
	 * RPC method: Set repo status directly (active, deactivated, deleted).
	 * Used by debug tools — does NOT delete data, only sets the status flag.
	 */
	async rpcSetRepoStatus(status: string): Promise<void> {
		const storage = await this.getStorage();
		storage.setStatus(status);
		const active = status === "active";
		await this.rpcEmitAccountEvent(active, active ? undefined : status);
	}

	/**
	 * RPC method: Emit an #account event to the firehose.
	 * Notifies relays of account lifecycle changes (activation, deactivation, deletion).
	 */
	async rpcEmitAccountEvent(
		active: boolean,
		status?: string,
	): Promise<{ seq: number }> {
		await this.ensureStorageInitialized();

		const did = this.storage!.getAtprotoDid();
		if (!did) {
			throw new Error("No DID found for account event");
		}

		const time = new Date().toISOString();

		const result = this.ctx.storage.sql
			.exec(
				`INSERT INTO firehose_events (event_type, payload)
				 VALUES ('account', ?)
				 RETURNING seq`,
				new Uint8Array(0),
			)
			.one();
		const seq = result.seq as number;

		const header = { op: 1, t: "#account" };
		const body: Record<string, unknown> = { seq, did, time, active };
		if (status) {
			body.status = status;
		}

		const headerBytes = cborEncode(header);
		const bodyBytes = cborEncode(body);
		const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
		frame.set(headerBytes, 0);
		frame.set(bodyBytes, headerBytes.length);

		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(frame);
			} catch (e) {
				console.error("Error broadcasting account event:", e);
			}
		}

		return { seq };
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
		const storage = await this.getStorage();

		// Only allow reset on deactivated accounts
		const isActive = await storage.getActive();
		if (isActive) {
			throw new Error(
				"AccountActive: Cannot reset migration on an active account. Deactivate first.",
			);
		}

		// Get counts before deletion for reporting
		const blocksDeleted = await storage.countBlocks();
		const blobsCleared = storage.countImportedBlobs();

		// Clear all blocks and reset repo state
		await storage.destroy();

		// Clear blob tracking tables
		storage.clearBlobTracking();

		// Reset in-memory repo reference so it gets reinitialized on next access
		this.repo = null;
		this.repoInitialized = false;

		return { blocksDeleted, blobsCleared };
	}

	/**
	 * Emit an identity event to notify downstream services to refresh identity cache.
	 */
	async rpcEmitIdentityEvent(handle: string): Promise<{ seq: number }> {
		await this.ensureStorageInitialized();

		// Get the DID from stored identity
		const did = this.storage!.getAtprotoDid();
		if (!did) {
			throw new Error("No DID found for identity event");
		}

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
			did,
			time,
			handle,
		};

		const headerBytes = cborEncode(header);
		const bodyBytes = cborEncode(body);
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

	/**
	 * RPC method: Check if a FID-PDS account exists.
	 * Returns true if an AT Protocol identity has been created for this FID.
	 * This checks identity existence only — a "deleted" repo status still means
	 * the account exists (the user can still manage their DID document).
	 */
	async rpcAccountExists(): Promise<boolean> {
		await this.ensureStorageInitialized();
		return this.storage!.hasAtprotoIdentity();
	}

	/** Get the account status (active, deactivated, deleted, or null if no identity) */
	async rpcGetAccountStatus(): Promise<string | null> {
		await this.ensureStorageInitialized();
		if (!this.storage!.hasAtprotoIdentity()) return null;
		return this.storage!.getStatus();
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
		subscribers: number;
		latestSeq: number;
	}> {
		const sockets = this.ctx.getWebSockets();
		await this.ensureStorageInitialized();
		const seq = this.sequencer!.getLatestSeq();
		return {
			subscribers: sockets.length,
			latestSeq: seq,
		};
	}

	// ============================================
	// OAuth Storage RPC Methods
	// These methods proxy to SqliteOAuthStorage since we can't serialize the storage object
	// ============================================

	/** Save an authorization code */
	async rpcSaveAuthCode(code: string, data: AuthCodeData): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveAuthCode(code, data);
	}

	/** Get authorization code data */
	async rpcGetAuthCode(code: string): Promise<AuthCodeData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getAuthCode(code);
	}

	/** Delete an authorization code */
	async rpcDeleteAuthCode(code: string): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.deleteAuthCode(code);
	}

	/** Save token data */
	async rpcSaveTokens(data: TokenData): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveTokens(data);
	}

	/** Get token data by access token */
	async rpcGetTokenByAccess(accessToken: string): Promise<TokenData | null> {
		const storage = await this.getOAuthStorage();
		return storage.getTokenByAccess(accessToken);
	}

	/** Get token data by refresh token */
	async rpcGetTokenByRefresh(refreshToken: string): Promise<TokenData | null> {
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
	async rpcSaveClient(clientId: string, metadata: ClientMetadata): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.saveClient(clientId, metadata);
	}

	/** Get client metadata */
	async rpcGetClient(clientId: string): Promise<ClientMetadata | null> {
		const storage = await this.getOAuthStorage();
		return storage.getClient(clientId);
	}

	/** Save PAR data */
	async rpcSavePAR(requestUri: string, data: PARData): Promise<void> {
		const storage = await this.getOAuthStorage();
		await storage.savePAR(requestUri, data);
	}

	/** Get PAR data */
	async rpcGetPAR(requestUri: string): Promise<PARData | null> {
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
		const storage = await this.getStorage();
		storage.savePasskey(credentialId, publicKey, counter, name);
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
		const storage = await this.getStorage();
		return storage.getPasskey(credentialId);
	}

	/** List all passkeys */
	async rpcListPasskeys(): Promise<Array<{
		credentialId: string;
		name: string | null;
		createdAt: string;
		lastUsedAt: string | null;
	}>> {
		const storage = await this.getStorage();
		return storage.listPasskeys();
	}

	/** Rename a passkey */
	async rpcRenamePasskey(credentialId: string, name: string): Promise<boolean> {
		const storage = await this.getStorage();
		return storage.renamePasskey(credentialId, name);
	}

	/** Delete a passkey */
	async rpcDeletePasskey(credentialId: string): Promise<boolean> {
		const storage = await this.getStorage();
		return storage.deletePasskey(credentialId);
	}

	/** Update passkey counter after authentication */
	async rpcUpdatePasskeyCounter(
		credentialId: string,
		counter: number,
	): Promise<void> {
		const storage = await this.getStorage();
		storage.updatePasskeyCounter(credentialId, counter);
	}

	/** Check if passkeys exist */
	async rpcHasPasskeys(): Promise<boolean> {
		const storage = await this.getStorage();
		return storage.hasPasskeys();
	}

	/** Save a registration token */
	async rpcSavePasskeyToken(
		token: string,
		challenge: string,
		expiresAt: number,
		name?: string,
	): Promise<void> {
		const storage = await this.getStorage();
		storage.savePasskeyToken(token, challenge, expiresAt, name);
	}

	/** Consume a registration token */
	async rpcConsumePasskeyToken(
		token: string,
	): Promise<{ challenge: string; name: string | null } | null> {
		const storage = await this.getStorage();
		return storage.consumePasskeyToken(token);
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
	// Account Deletion
	// ============================================

	/**
	 * RPC method: Delete an account (tombstone-preserving).
	 *
	 * Removes R2 blobs, clears bulk data and signing keys via targeted SQL
	 * DELETEs, and marks the account as deleted. The DID and handle are
	 * retained so the DO can still serve tombstone responses (firehose
	 * #account events, DID doc 404s).
	 *
	 * Uses targeted SQL DELETEs instead of ctx.storage.deleteAll() because
	 * deleteAll() destroys the SQLite database, making the DO unable to
	 * handle subsequent requests (e.g. firehose tombstone WebSocket upgrades).
	 */
	async rpcDeleteRepo(): Promise<void> {
		await this.ensureStorageInitialized();

		// 1. Emit #account deletion event and broadcast to connected clients
		await this.rpcEmitAccountEvent(false, "deleted");

		// 2. Close all active WebSocket connections
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, "AccountDeleted");
			} catch (_) {
				// ignore already-closed sockets
			}
		}

		// 3. Delete R2 blobs
		if (this.env.BLOBS) {
			const did = this.storage!.getAtprotoDid();
			if (did) {
				const store = new BlobStore(this.env.BLOBS, did);
				await store.deleteAllBlobs();
			}
		}

		// 4. Mark account as deleted (tombstone-preserving)
		this.storage!.setStatus("deleted");
		this.storage!.clearSigningKeys();
		this.storage!.clearBulkData();

		// 5. Delete all firehose events except the tombstone #account event
		const tombstoneSeq = this.ctx.storage.sql
			.exec(
				`SELECT MAX(seq) as seq FROM firehose_events WHERE event_type = 'account'`,
			)
			.one();
		if (tombstoneSeq?.seq) {
			this.ctx.storage.sql.exec(
				`DELETE FROM firehose_events WHERE seq < ?`,
				tombstoneSeq.seq as number,
			);
		}

		// 6. Clear OAuth data
		if (this.oauthStorage) {
			this.ctx.storage.sql.exec("DELETE FROM oauth_auth_codes");
			this.ctx.storage.sql.exec("DELETE FROM oauth_tokens");
			this.ctx.storage.sql.exec("DELETE FROM oauth_clients");
			this.ctx.storage.sql.exec("DELETE FROM oauth_par_requests");
			this.ctx.storage.sql.exec("DELETE FROM oauth_nonces");
			this.ctx.storage.sql.exec("DELETE FROM oauth_webauthn_challenges");
		}

		// 7. Cancel periodic cleanup alarm
		await this.ctx.storage.deleteAlarm();

		// 8. Reset in-memory state
		this.repo = null;
		this.keypair = null;
		this.blobStore = null;
		this.cachedIdentity = null;
		this.repoInitialized = false;
	}

	/**
	 * Advance the firehose seq floor past a given value.
	 * Used manually to fix FutureCursor issues when a relay's cursor
	 * is ahead of the PDS seq (e.g. after account deletion/recreation).
	 */
	async rpcSyncRelaySeq(floor: number): Promise<{ newSeq: number }> {
		await this.ensureStorageInitialized();
		this.sequencer!.setSeqFloor(floor);
		return { newSeq: this.sequencer!.getLatestSeq() };
	}

	// ============================================
	// AT Protocol Identity RPC Methods (Multi-tenant FID PDS)
	// ============================================

	/** Get AT Protocol identity */
	async rpcGetAtprotoIdentity(): Promise<{
		did: string;
		handle: string;
		signingKey: string;
		signingKeyPublic: string;
		createdAt: string;
		updatedAt: string;
	} | null> {
		const storage = await this.getStorage();
		return storage.getAtprotoIdentity();
	}

	/** Set AT Protocol identity (can only be called once per account) */
	async rpcSetAtprotoIdentity(identity: {
		did: string;
		handle: string;
		signingKey: string;
		signingKeyPublic: string;
	}): Promise<void> {
		const storage = await this.getStorage();
		storage.setAtprotoIdentity(identity);
	}

	/** Get the public signing key (for DID document generation) */
	async rpcGetAtprotoPublicKey(): Promise<string | null> {
		const storage = await this.getStorage();
		return storage.getAtprotoPublicKey();
	}

	/** Get the DID for this account */
	async rpcGetAtprotoDid(): Promise<string | null> {
		const storage = await this.getStorage();
		return storage.getAtprotoDid();
	}

	/** Get the custom PDS URL for this account */
	async rpcGetCustomPdsUrl(): Promise<string | null> {
		const storage = await this.getStorage();
		return storage.getCustomPdsUrl();
	}

	/** Set the custom PDS URL for this account */
	async rpcSetCustomPdsUrl(url: string | null): Promise<void> {
		const storage = await this.getStorage();
		storage.setCustomPdsUrl(url);
	}

	/** Get the custom verification key for this account */
	async rpcGetCustomVerificationKey(): Promise<string | null> {
		const storage = await this.getStorage();
		return storage.getCustomVerificationKey();
	}

	/** Set the custom verification key for this account */
	async rpcSetCustomVerificationKey(key: string | null): Promise<void> {
		const storage = await this.getStorage();
		storage.setCustomVerificationKey(key);
	}

	/** Update the stored handle for this account */
	async rpcUpdateHandle(handle: string): Promise<void> {
		const storage = await this.getStorage();
		storage.updateHandle(handle);
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

/**
 * Serialize a record for JSON by converting CID objects to { $link: "..." } format.
 * CBOR-decoded records contain raw CID objects that need conversion for JSON serialization.
 */
function serializeRecord(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;

	// Check if this is a CID object using @atproto/lex-data helper
	const cid = asCid(obj);
	if (cid) {
		return { $link: cid.toString() };
	}

	// Convert Uint8Array to { $bytes: "<base64>" }
	if (obj instanceof Uint8Array) {
		let binary = "";
		for (let i = 0; i < obj.length; i++) {
			binary += String.fromCharCode(obj[i]!);
		}
		return { $bytes: btoa(binary) };
	}

	if (Array.isArray(obj)) {
		return obj.map(serializeRecord);
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = serializeRecord(value);
		}
		return result;
	}

	return obj;
}

/**
 * Extract blob CIDs from a record by recursively searching for blob references.
 * Blob refs have the structure: { $type: "blob", ref: CID, mimeType, size }
 */
function extractBlobCids(obj: unknown): string[] {
	const cids: string[] = [];

	function walk(value: unknown): void {
		if (value === null || value === undefined) return;

		// Check if this is a blob reference using @atproto/lex-data helper
		if (isBlobRef(value)) {
			cids.push(value.ref.toString());
			return; // No need to recurse into blob ref properties
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item);
			}
		} else if (typeof value === "object") {
			// Recursively walk all properties
			for (const key of Object.keys(value as Record<string, unknown>)) {
				walk((value as Record<string, unknown>)[key]);
			}
		}
	}

	walk(obj);
	return cids;
}
