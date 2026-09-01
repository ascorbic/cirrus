import {
	Repo,
	WriteOpAction,
	BlockMap,
	readCarWithRoot,
	cidForRecord,
	type RecordCreateOp,
	type RecordUpdateOp,
	type RecordDeleteOp,
	type RecordWriteOp,
} from "@atproto/repo";
import { Secp256k1Keypair } from "@atproto/crypto";
import { CID, asCid, isBlobRef } from "@atproto/lex-data";
import { now as tidNow } from "@atcute/tid";
import { jsonToLex } from "@atproto/lex-json";
import { SqliteRepoStorage } from "./storage";
import type { Sequencer, SeqEvent, CommitData } from "./sequencer";
import { RecordAlreadyExistsError, type ValidationStatus } from "../validation";

/** Record type compatible with @atproto/repo operations */
type RepoRecord = Record<string, unknown>;

/** Sync 1.1 spec: at most 200 record operations per commit. */
const MAX_OPS_PER_COMMIT = 200;

export interface RepoEngineOpts {
	storage: SqliteRepoStorage;
	sequencer: Sequencer;
	did: string;
	signingKey: string;
	/** Serializes repo initialization; the DO backs this with blockConcurrencyWhile. */
	lock: <T>(fn: () => Promise<T>) => Promise<T>;
	broadcast: (event: SeqEvent) => Promise<void>;
}

/**
 * The repository engine: owns the @atproto/repo instance and signing
 * keypair, and implements record reads and writes, firehose sequencing,
 * account activation, CAR import and migration reset. Depends only on
 * SQLite-backed storage, the sequencer and a broadcast callback — no
 * Durable Object or person-account concerns.
 */
export class RepoEngine {
	private storage: SqliteRepoStorage;
	private sequencer: Sequencer;
	private did: string;
	private signingKey: string;
	private lock: <T>(fn: () => Promise<T>) => Promise<T>;
	private broadcast: (event: SeqEvent) => Promise<void>;

	private repo: Repo | null = null;
	private keypair: Secp256k1Keypair | null = null;
	private initialized = false;

	constructor(opts: RepoEngineOpts) {
		this.storage = opts.storage;
		this.sequencer = opts.sequencer;
		this.did = opts.did;
		this.signingKey = opts.signingKey;
		this.lock = opts.lock;
		this.broadcast = opts.broadcast;
	}

	/**
	 * Initialize the Repo instance. Called lazily on first repo access.
	 */
	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.lock(async () => {
				if (this.initialized) return; // Double-check after acquiring lock

				// Load signing key
				this.keypair = await Secp256k1Keypair.import(this.signingKey);

				// Load or create repo
				const root = await this.storage.getRoot();
				if (root) {
					this.repo = await Repo.load(this.storage, root);
				} else {
					this.repo = await Repo.create(this.storage, this.did, this.keypair);
				}

				this.initialized = true;
			});
		}
	}

	/**
	 * Get the Repo instance for repository operations.
	 */
	async getRepo(): Promise<Repo> {
		await this.ensureInitialized();
		return this.repo!;
	}

	/**
	 * Get the signing keypair for repository operations.
	 */
	async getKeypair(): Promise<Secp256k1Keypair> {
		await this.ensureInitialized();
		return this.keypair!;
	}

	/**
	 * Update the Repo instance after mutations.
	 */
	setRepo(repo: Repo): void {
		this.repo = repo;
	}

	/**
	 * Drop the in-memory repo so the next access reloads from storage.
	 * Used after a write fails post-applyWrites: Cloudflare rolls back the
	 * SQLite writes, but JS state isn't rolled back, so the cached Repo can
	 * end up ahead of storage. That mismatch produces firehose events whose
	 * `since` rev the relay never saw, causing it to mark us desynced.
	 */
	private invalidate(): void {
		this.repo = null;
		this.initialized = false;
	}

	/**
	 * Ensure the account is active. Throws error if deactivated.
	 */
	async ensureActive(): Promise<void> {
		const isActive = await this.storage.getActive();
		if (!isActive) {
			throw new Error(
				"AccountDeactivated: Account is deactivated. Call activateAccount to enable writes.",
			);
		}
	}

	/**
	 * Get repo metadata for describeRepo.
	 */
	async describeRepo(): Promise<{
		did: string;
		collections: string[];
		cid: string;
	}> {
		const repo = await this.getRepo();

		// Lazy backfill: if the cache is empty and the repo has content, populate it
		if (!this.storage.hasCollections() && (await this.storage.getRoot())) {
			const seen = new Set<string>();
			for await (const record of repo.walkRecords()) {
				if (!seen.has(record.collection)) {
					seen.add(record.collection);
					this.storage.addCollection(record.collection);
				}
			}
		}

		return {
			did: repo.did,
			collections: this.storage.getCollections(),
			cid: repo.cid.toString(),
		};
	}

	/**
	 * Get a single record.
	 */
	async getRecord(
		collection: string,
		rkey: string,
	): Promise<{
		cid: string;
		record: unknown;
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
			record: serializeRecord(record),
		};
	}

	/**
	 * List records in a collection.
	 */
	async listRecords(
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
	 * Create a record.
	 */
	async createRecord(
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
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		// Auto-generate rkey here (not in the worker) so the candidate is
		// chosen against this DO's authoritative MST state, eliminating the
		// 1/1024 collision risk between worker isolates picking the same
		// timestamp+clockid in the same ms. For client-supplied rkeys, throw
		// a structured RecordAlreadyExistsError if it collides. Use the
		// MST's CID lookup (data.get) instead of repo.getRecord to avoid
		// fetching and decoding the full record block on every write.
		const autoGenerated = rkey === undefined;
		let actualRkey = rkey ?? tidNow();
		for (let attempt = 0; attempt < 5; attempt++) {
			const existingCid = await repo.data.get(`${collection}/${actualRkey}`);
			if (!existingCid) break;
			if (!autoGenerated) {
				throw new RecordAlreadyExistsError(`${collection}/${actualRkey}`);
			}
			if (attempt === 4) {
				throw new Error(
					`Failed to allocate unique rkey for ${collection} after 5 attempts`,
				);
			}
			actualRkey = tidNow();
		}

		const createOp: RecordCreateOp = {
			action: WriteOpAction.Create,
			collection,
			rkey: actualRkey,
			record: jsonToLex(record as any) as RepoRecord,
		};

		const prevRev = repo.commit.rev;
		const prevData = repo.commit.data;
		const commit = await repo.formatCommit([createOp], keypair);
		const updatedRepo = await repo.applyCommit(commit);

		try {
			const dataKey = `${collection}/${actualRkey}`;
			const recordCid = await updatedRepo.data.get(dataKey);

			if (!recordCid) {
				throw new Error(`Failed to create record: ${collection}/${actualRkey}`);
			}

			this.storage.addCollection(collection);

			const opWithCid = { ...createOp, cid: recordCid };

			const commitData: CommitData = {
				did: updatedRepo.did,
				commit: commit.cid,
				rev: commit.rev,
				since: prevRev,
				prevData,
				newBlocks: commit.newBlocks,
				relevantBlocks: commit.relevantBlocks,
				ops: [opWithCid],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcast(event);

			this.repo = updatedRepo;

			return {
				uri: `at://${updatedRepo.did}/${collection}/${actualRkey}`,
				cid: recordCid.toString(),
				commit: {
					cid: updatedRepo.cid.toString(),
					rev: updatedRepo.commit.rev,
				},
				...(validationStatus !== undefined ? { validationStatus } : {}),
			};
		} catch (err) {
			this.invalidate();
			throw err;
		}
	}

	/**
	 * Delete a record.
	 */
	async deleteRecord(
		collection: string,
		rkey: string,
	): Promise<{ commit: { cid: string; rev: string } } | null> {
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const existingCid = await repo.data.get(`${collection}/${rkey}`);
		if (!existingCid) return null;

		const deleteOp: RecordDeleteOp = {
			action: WriteOpAction.Delete,
			collection,
			rkey,
		};

		const prevRev = repo.commit.rev;
		const prevData = repo.commit.data;
		const commit = await repo.formatCommit([deleteOp], keypair);
		const updatedRepo = await repo.applyCommit(commit);

		try {
			const commitData: CommitData = {
				did: updatedRepo.did,
				commit: commit.cid,
				rev: commit.rev,
				since: prevRev,
				prevData,
				newBlocks: commit.newBlocks,
				relevantBlocks: commit.relevantBlocks,
				ops: [{ ...deleteOp, cid: null, prev: existingCid }],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcast(event);

			this.repo = updatedRepo;

			// If the collection has no records left, remove it from the cache
			let collectionStillHasRecords = false;
			for await (const remaining of updatedRepo.walkRecords(`${collection}/`)) {
				if (remaining.collection !== collection) break;
				collectionStillHasRecords = true;
				break;
			}
			if (!collectionStillHasRecords) {
				this.storage.removeCollection(collection);
			}

			return {
				commit: {
					cid: updatedRepo.cid.toString(),
					rev: updatedRepo.commit.rev,
				},
			};
		} catch (err) {
			this.invalidate();
			throw err;
		}
	}

	/**
	 * Put a record (create or update).
	 */
	async putRecord(
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
		await this.ensureActive();
		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		const existingCid = await repo.data.get(`${collection}/${rkey}`);
		const isUpdate = existingCid !== null;

		const normalizedRecord = jsonToLex(record as any) as RepoRecord;
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
		const prevData = repo.commit.data;
		const commit = await repo.formatCommit([op], keypair);
		const updatedRepo = await repo.applyCommit(commit);

		try {
			const dataKey = `${collection}/${rkey}`;
			const recordCid = await updatedRepo.data.get(dataKey);

			if (!recordCid) {
				throw new Error(`Failed to put record: ${collection}/${rkey}`);
			}

			this.storage.addCollection(collection);

			const opWithCid: CommitData["ops"][number] = {
				...op,
				cid: recordCid,
			};
			if (existingCid) opWithCid.prev = existingCid;

			const commitData: CommitData = {
				did: updatedRepo.did,
				commit: commit.cid,
				rev: commit.rev,
				since: prevRev,
				prevData,
				newBlocks: commit.newBlocks,
				relevantBlocks: commit.relevantBlocks,
				ops: [opWithCid],
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcast(event);

			this.repo = updatedRepo;

			return {
				uri: `at://${updatedRepo.did}/${collection}/${rkey}`,
				cid: recordCid.toString(),
				commit: {
					cid: updatedRepo.cid.toString(),
					rev: updatedRepo.commit.rev,
				},
				...(validationStatus !== undefined ? { validationStatus } : {}),
			};
		} catch (err) {
			this.invalidate();
			throw err;
		}
	}

	/**
	 * Apply multiple writes (batch create/update/delete).
	 */
	async applyWrites(
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
		await this.ensureActive();

		// Spec limit: at most 200 operations per #commit.
		if (writes.length > MAX_OPS_PER_COMMIT) {
			throw new Error(
				`InvalidRequest: applyWrites accepts at most ${MAX_OPS_PER_COMMIT} operations per call, got ${writes.length}`,
			);
		}

		const repo = await this.getRepo();
		const keypair = await this.getKeypair();

		// Convert input writes to RecordWriteOp format
		const ops: RecordWriteOp[] = [];
		const results: Array<{
			$type: string;
			uri?: string;
			cid?: string;
			validationStatus?: ValidationStatus;
			collection: string;
			rkey: string;
			action: WriteOpAction;
		}> = [];

		// Track rkeys this batch will write so two auto-generated creates in
		// the same batch don't pick the same rkey.
		const reservedRkeys = new Set<string>();

		for (const write of writes) {
			if (write.$type === "com.atproto.repo.applyWrites#create") {
				const autoGenerated = write.rkey === undefined;
				let rkey = write.rkey ?? tidNow();
				for (let attempt = 0; attempt < 5; attempt++) {
					const composite = `${write.collection}/${rkey}`;
					const collidesInBatch = reservedRkeys.has(composite);
					const collidesInRepo =
						!collidesInBatch && (await repo.data.get(composite)) !== null;
					if (!collidesInBatch && !collidesInRepo) break;
					if (!autoGenerated) {
						throw new RecordAlreadyExistsError(composite);
					}
					if (attempt === 4) {
						throw new Error(
							`Failed to allocate unique rkey for ${write.collection} after 5 attempts`,
						);
					}
					rkey = tidNow();
				}
				reservedRkeys.add(`${write.collection}/${rkey}`);
				const op: RecordCreateOp = {
					action: WriteOpAction.Create,
					collection: write.collection,
					rkey,
					record: jsonToLex(write.value as any) as RepoRecord,
				};
				ops.push(op);
				results.push({
					$type: "com.atproto.repo.applyWrites#createResult",
					collection: write.collection,
					rkey,
					action: WriteOpAction.Create,
					validationStatus: write.validationStatus,
				});
			} else if (write.$type === "com.atproto.repo.applyWrites#update") {
				if (!write.rkey) {
					throw new Error("Update requires rkey");
				}
				const op: RecordUpdateOp = {
					action: WriteOpAction.Update,
					collection: write.collection,
					rkey: write.rkey,
					record: jsonToLex(write.value as any) as RepoRecord,
				};
				ops.push(op);
				results.push({
					$type: "com.atproto.repo.applyWrites#updateResult",
					collection: write.collection,
					rkey: write.rkey,
					action: WriteOpAction.Update,
					validationStatus: write.validationStatus,
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

		// Capture prev CIDs for every update/delete *before* the write, so the
		// firehose can emit ops[].prev per sync 1.1. Matches reference PDS
		// behaviour: prev is read from pre-batch MST state only, so a delete
		// for a record that was also created earlier in the same batch will
		// have no prev (the record didn't exist before the batch).
		const prevCids = new Map<string, CID>();
		for (const op of ops) {
			if (op.action === WriteOpAction.Create) continue;
			const key = `${op.collection}/${op.rkey}`;
			if (prevCids.has(key)) continue;
			const cid = await repo.data.get(key);
			if (cid) prevCids.set(key, cid);
		}

		// Precompute every create/update record's CID. The lexicon marks
		// `cid` as required on createResult / updateResult, and we can't rely
		// on the post-commit MST: a create that is deleted later in the same
		// batch leaves no entry. cidForRecord is deterministic from the
		// record bytes and matches what formatCommit stores in the MST.
		const opCids: Array<CID | undefined> = new Array(ops.length);
		for (let i = 0; i < ops.length; i++) {
			const op = ops[i]!;
			if (op.action !== WriteOpAction.Delete) {
				opCids[i] = await cidForRecord(op.record);
			}
		}

		const prevRev = repo.commit.rev;
		const prevData = repo.commit.data;
		const commit = await repo.formatCommit(ops, keypair);
		const updatedRepo = await repo.applyCommit(commit);

		try {
			for (const op of ops) {
				if (op.action !== WriteOpAction.Delete) {
					this.storage.addCollection(op.collection);
				}
			}

			const finalResults: Array<{
				$type: string;
				uri?: string;
				cid?: string;
				validationStatus?: ValidationStatus;
			}> = [];
			const opsWithCids: CommitData["ops"] = [];

			for (let i = 0; i < results.length; i++) {
				const result = results[i]!;
				const op = ops[i]!;
				const prev = prevCids.get(`${op.collection}/${op.rkey}`);

				if (result.action === WriteOpAction.Delete) {
					finalResults.push({
						$type: result.$type,
					});
					opsWithCids.push({
						...op,
						cid: null,
						...(prev ? { prev } : {}),
					});
				} else {
					const recordCid = opCids[i]!;
					finalResults.push({
						$type: result.$type,
						uri: `at://${updatedRepo.did}/${result.collection}/${result.rkey}`,
						cid: recordCid.toString(),
						...(result.validationStatus !== undefined
							? { validationStatus: result.validationStatus }
							: {}),
					});
					opsWithCids.push({
						...op,
						cid: recordCid,
						...(prev ? { prev } : {}),
					});
				}
			}

			const commitData: CommitData = {
				did: updatedRepo.did,
				commit: commit.cid,
				rev: commit.rev,
				since: prevRev,
				prevData,
				newBlocks: commit.newBlocks,
				relevantBlocks: commit.relevantBlocks,
				ops: opsWithCids,
			};

			const event = await this.sequencer.sequenceCommit(commitData);
			await this.broadcast(event);

			this.repo = updatedRepo;

			// For any collection touched by a delete, drop the cache entry if it's
			// now empty. Runs after addCollection so a batch that creates + deletes
			// in the same collection still walks the MST as the source of truth.
			const deletedCollections = new Set<string>();
			for (const op of ops) {
				if (op.action === WriteOpAction.Delete) {
					deletedCollections.add(op.collection);
				}
			}
			for (const collection of deletedCollections) {
				let collectionStillHasRecords = false;
				for await (const remaining of updatedRepo.walkRecords(
					`${collection}/`,
				)) {
					if (remaining.collection !== collection) break;
					collectionStillHasRecords = true;
					break;
				}
				if (!collectionStillHasRecords) {
					this.storage.removeCollection(collection);
				}
			}

			return {
				commit: {
					cid: updatedRepo.cid.toString(),
					rev: updatedRepo.commit.rev,
				},
				results: finalResults,
			};
		} catch (err) {
			this.invalidate();
			throw err;
		}
	}

	/**
	 * Get repo status.
	 */
	async getStatus(): Promise<{
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
	 * Count records in the repository.
	 */
	async countRecords(): Promise<number> {
		const repo = await this.getRepo();
		let count = 0;
		for await (const _record of repo.walkRecords()) {
			count++;
		}
		return count;
	}

	/**
	 * Activate the account.
	 * Emits #account + #identity + #sync per sync 1.1, so relays pick up
	 * the new state without polling. #sync is only emitted when a repo
	 * root exists (i.e. after migration import or initial commit).
	 */
	async activateAccount(): Promise<void> {
		const wasActive = await this.storage.getActive();
		await this.storage.setActive(true);
		if (wasActive) return;

		const account = await this.sequencer.sequenceAccount({
			did: this.did,
			active: true,
		});
		await this.broadcast(account);

		const identity = await this.sequencer.sequenceIdentity({
			did: this.did,
		});
		await this.broadcast(identity);

		const root = await this.storage.getRoot();
		if (root) {
			const commitBytes = await this.storage.getBytes(root);
			if (commitBytes) {
				const repo = await this.getRepo();
				const blocks = new BlockMap();
				blocks.set(root, commitBytes);
				const sync = await this.sequencer.sequenceSync({
					did: this.did,
					rev: repo.commit.rev,
					cid: root,
					blocks,
				});
				await this.broadcast(sync);
			}
		}
	}

	/**
	 * Deactivate the account.
	 * Emits #account(active=false, status='deactivated') per sync 1.1.
	 */
	async deactivateAccount(): Promise<void> {
		const wasActive = await this.storage.getActive();
		await this.storage.setActive(false);
		if (!wasActive) return;

		const account = await this.sequencer.sequenceAccount({
			did: this.did,
			active: false,
			status: "deactivated",
		});
		await this.broadcast(account);
	}

	/**
	 * Emit an identity event to notify downstream services to refresh
	 * identity cache. `handle` is optional per sync 1.1.
	 */
	async emitIdentityEvent(handle?: string): Promise<{ seq: number }> {
		const event = await this.sequencer.sequenceIdentity({
			did: this.did,
			...(handle ? { handle } : {}),
		});
		await this.broadcast(event);
		return { seq: event.seq };
	}

	/**
	 * Import a repo from a CAR file. Used for account migration —
	 * importing an existing repository from another PDS.
	 */
	async importRepo(carBytes: Uint8Array): Promise<{
		did: string;
		rev: string;
		cid: string;
	}> {
		// Check if account is active - only allow imports on deactivated accounts
		const isActive = await this.storage.getActive();
		const existingRoot = await this.storage.getRoot();

		if (isActive && existingRoot) {
			// Account is active - reject import to prevent accidental overwrites
			throw new Error(
				"Repository already exists. Cannot import over existing repository.",
			);
		}

		// If deactivated and repo exists, clear it first
		if (existingRoot) {
			await this.storage.destroy();
			this.repo = null;
			this.initialized = false;
		}

		// Use official @atproto/repo utilities to read and validate CAR
		// readCarWithRoot validates single root requirement and returns BlockMap
		const { root: rootCid, blocks } = await readCarWithRoot(carBytes);

		// Import all blocks into storage using putMany (more efficient than individual putBlock)
		const importRev = tidNow();
		await this.storage.putMany(blocks, importRev);

		// Load the repo to verify it's valid and get the actual revision
		this.keypair = await Secp256k1Keypair.import(this.signingKey);
		this.repo = await Repo.load(this.storage, rootCid);

		// Persist the root CID in storage so getRoot() works correctly
		await this.storage.updateRoot(rootCid, this.repo.commit.rev);

		// Verify the DID matches to prevent incorrect migrations
		if (this.repo.did !== this.did) {
			// Clean up imported blocks
			await this.storage.destroy();
			throw new Error(
				`DID mismatch: CAR file contains DID ${this.repo.did}, but expected ${this.did}`,
			);
		}

		this.initialized = true;

		// Extract blob references and collection names from all imported records
		const seenCollections = new Set<string>();
		for await (const record of this.repo.walkRecords()) {
			if (!seenCollections.has(record.collection)) {
				seenCollections.add(record.collection);
				this.storage.addCollection(record.collection);
			}
			const blobCids = extractBlobCids(record.record);
			if (blobCids.length > 0) {
				const uri = `at://${this.repo.did}/${record.collection}/${record.rkey}`;
				this.storage.addRecordBlobs(uri, blobCids);
			}
		}

		return {
			did: this.repo.did,
			rev: this.repo.commit.rev,
			cid: rootCid.toString(),
		};
	}

	/**
	 * Reset migration state.
	 * Clears imported repo and blob tracking to allow re-import.
	 * Only works when account is deactivated.
	 */
	async resetMigration(): Promise<{
		blocksDeleted: number;
		blobsCleared: number;
	}> {
		// Only allow reset on deactivated accounts
		const isActive = await this.storage.getActive();
		if (isActive) {
			throw new Error(
				"AccountActive: Cannot reset migration on an active account. Deactivate first.",
			);
		}

		// Get counts before deletion for reporting
		const blocksDeleted = await this.storage.countBlocks();
		const blobsCleared = this.storage.countImportedBlobs();

		// Clear all blocks and reset repo state
		await this.storage.destroy();

		// Clear blob tracking tables
		this.storage.clearBlobTracking();

		// Reset in-memory repo reference so it gets reinitialized on next access
		this.repo = null;
		this.initialized = false;

		return { blocksDeleted, blobsCleared };
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

	// @atproto/repo's walkRecords() decodes blobs as the legacy
	// @atproto/lexicon BlobRef class. Honor its JSON representation before
	// walking enumerable properties, otherwise the internal `original` field
	// leaks into listRecords and the outer `$type: "blob"` is lost.
	if (
		typeof obj === "object" &&
		"toJSON" in obj &&
		typeof obj.toJSON === "function"
	) {
		const json = obj.toJSON();
		if (json !== obj) return serializeRecord(json);
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
