import { RpcTarget } from "cloudflare:workers";
import type { RepoEngine } from "./engine";
import type { SqliteRepoStorage } from "./storage";
import { getBlocksCar, getRecordProofCar } from "./sync";
import type { ValidationStatus } from "../validation";

/**
 * The repo host's remote surface: the subset of engine and storage
 * operations that is safe to call over Workers RPC. The Durable Object
 * hands this to the Worker as a stub (via repo()); methods returning
 * non-serializable objects (Repo, Keypair) stay off it by design.
 */
export class RepoFacet extends RpcTarget {
	constructor(
		private engine: RepoEngine,
		private storage: SqliteRepoStorage,
	) {
		super();
	}

	describeRepo(): Promise<{
		did: string;
		collections: string[];
		cid: string;
	}> {
		return this.engine.describeRepo();
	}

	getRecord(
		collection: string,
		rkey: string,
	): Promise<{
		cid: string;
		record: Rpc.Serializable<any>;
	} | null> {
		return this.engine.getRecord(collection, rkey) as Promise<{
			cid: string;
			record: Rpc.Serializable<any>;
		} | null>;
	}

	listRecords(
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
		return this.engine.listRecords(collection, opts);
	}

	createRecord(
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
		return this.engine.createRecord(collection, rkey, record, validationStatus);
	}

	deleteRecord(
		collection: string,
		rkey: string,
	): Promise<{ commit: { cid: string; rev: string } } | null> {
		return this.engine.deleteRecord(collection, rkey);
	}

	putRecord(
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
		return this.engine.putRecord(collection, rkey, record, validationStatus);
	}

	applyWrites(
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
		return this.engine.applyWrites(writes);
	}

	getStatus(): Promise<{
		did: string;
		head: string;
		rev: string;
	}> {
		return this.engine.getStatus();
	}

	getActive(): Promise<boolean> {
		return this.storage.getActive();
	}

	countRecords(): Promise<number> {
		return this.engine.countRecords();
	}

	activateAccount(): Promise<void> {
		return this.engine.activateAccount();
	}

	deactivateAccount(): Promise<void> {
		return this.engine.deactivateAccount();
	}

	emitIdentityEvent(handle?: string): Promise<{ seq: number }> {
		return this.engine.emitIdentityEvent(handle);
	}

	importRepo(carBytes: Uint8Array): Promise<{
		did: string;
		rev: string;
		cid: string;
	}> {
		return this.engine.importRepo(carBytes);
	}

	resetMigration(): Promise<{
		blocksDeleted: number;
		blobsCleared: number;
	}> {
		return this.engine.resetMigration();
	}

	/**
	 * Get specific blocks by CID as a CAR file.
	 */
	getBlocks(cids: string[]): Promise<Uint8Array> {
		return getBlocksCar(this.storage, cids);
	}

	/**
	 * Get a record with proof as a CAR file.
	 */
	getRecordProof(collection: string, rkey: string): Promise<Uint8Array> {
		return getRecordProofCar(this.storage, collection, rkey);
	}

	countBlocks(): Promise<number> {
		return this.storage.countBlocks();
	}

	countExpectedBlobs(): number {
		return this.storage.countExpectedBlobs();
	}

	countImportedBlobs(): number {
		return this.storage.countImportedBlobs();
	}

	listMissingBlobs(
		limit?: number,
		cursor?: string,
	): { blobs: Array<{ cid: string; recordUri: string }>; cursor?: string } {
		return this.storage.listMissingBlobs(limit, cursor);
	}

	/**
	 * Record an already-stored blob's metadata.
	 *
	 * The blob bytes are written to R2 by the stateless Worker, not here.
	 * This DO is single-threaded and also holds the relay's firehose
	 * WebSocket; awaiting an R2 put inside it (R2 latency is independent of
	 * object size — even a small image can stall) pins the input gate, and
	 * Cloudflare resets the object when a storage op can't complete in time,
	 * dropping the firehose and desyncing the relay. Only the tiny tracking
	 * row needs the DO's SQLite.
	 */
	trackBlob(
		cid: string,
		size: number,
		mimeType: string,
	): { referenced: boolean } {
		this.storage.trackImportedBlob(cid, size, mimeType);
		// Report whether an existing record already references this CID so
		// the Worker can promote the staged upload immediately (migration
		// uploads arrive after their referencing records were imported, so
		// no later record write will do it).
		return { referenced: this.storage.isBlobReferenced(cid) };
	}
}
