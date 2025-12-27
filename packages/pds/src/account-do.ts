import { DurableObject } from "cloudflare:workers";
import {
	Repo,
	WriteOpAction,
	type RecordCreateOp,
	type RecordDeleteOp,
} from "@atproto/repo";
import type { RepoRecord } from "@atproto/lexicon";
import { Secp256k1Keypair } from "@atproto/crypto";
import { SqliteRepoStorage } from "./storage";
import { CID } from "multiformats/cid";
import { encode } from "@ipld/dag-cbor";
import { encode as varintEncode } from "varint";
import { concat } from "uint8arrays";

/**
 * Account Durable Object - manages a single user's AT Protocol repository.
 *
 * This DO provides:
 * - SQLite-backed block storage for the repository
 * - AT Protocol Repo instance for repository operations
 * - Firehose WebSocket connections
 * - Sequence number management
 */
export class AccountDurableObject extends DurableObject<Env> {
	private storage: SqliteRepoStorage | null = null;
	private repo: Repo | null = null;
	private keypair: Secp256k1Keypair | null = null;
	private storageInitialized = false;
	private repoInitialized = false;

	constructor(ctx: DurableObjectState, env: Env) {
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

				this.storage = new SqliteRepoStorage(this.ctx.storage.sql);
				this.storage.initSchema();
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
	 * Get the Repo instance for repository operations.
	 */
	async getRepo(): Promise<Repo> {
		await this.ensureRepoInitialized();
		return this.repo!;
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
				uri: `at://${repo.did}/${record.collection}/${record.rkey}`,
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
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const actualRkey = rkey || this.generateRkey();
		const createOp: RecordCreateOp = {
			action: WriteOpAction.Create,
			collection,
			rkey: actualRkey,
			record: record as RepoRecord,
		};

		const updatedRepo = await repo.applyWrites([createOp], keypair);
		this.repo = updatedRepo;

		// Get the CID for the created record from the MST
		const dataKey = `${collection}/${actualRkey}`;
		const recordCid = await this.repo.data.get(dataKey);

		if (!recordCid) {
			throw new Error(`Failed to create record: ${collection}/${actualRkey}`);
		}

		return {
			uri: `at://${this.repo.did}/${collection}/${actualRkey}`,
			cid: recordCid.toString(),
			commit: {
				cid: this.repo.cid.toString(),
				rev: this.repo.cid.toString(),
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
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const existing = await repo.getRecord(collection, rkey);
		if (!existing) return null;

		const deleteOp: RecordDeleteOp = {
			action: WriteOpAction.Delete,
			collection,
			rkey,
		};

		const updatedRepo = await repo.applyWrites([deleteOp], keypair);
		this.repo = updatedRepo;

		return {
			commit: {
				cid: updatedRepo.cid.toString(),
				rev: updatedRepo.cid.toString(),
			},
		};
	}

	/**
	 * RPC method: Get repo status
	 */
	async rpcGetRepoStatus(): Promise<{
		did: string;
		rev: string;
	}> {
		const repo = await this.getRepo();
		return {
			did: repo.did,
			rev: repo.cid.toString(),
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

		// Build CAR file manually to avoid async generator issues
		const chunks: Uint8Array[] = [];

		// CAR header
		const header = new Uint8Array(
			encode({
				version: 1,
				roots: [root],
			}),
		);
		chunks.push(new Uint8Array(varintEncode(header.byteLength)));
		chunks.push(header);

		// Add each block
		for (const row of rows) {
			const cidStr = row.cid as string;
			const bytes = new Uint8Array(row.bytes as ArrayBuffer);
			const cid = CID.parse(cidStr);

			// Block format: varint(cid.bytes.length + block.length) + cid.bytes + block
			chunks.push(
				new Uint8Array(varintEncode(cid.bytes.byteLength + bytes.byteLength)),
			);
			chunks.push(cid.bytes);
			chunks.push(bytes);
		}

		// Concatenate all chunks
		return concat(chunks);
	}

	private generateRkey(): string {
		return Date.now().toString(36) + Math.random().toString(36).slice(2);
	}
}
