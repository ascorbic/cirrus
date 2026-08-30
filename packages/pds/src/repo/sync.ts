import { CID } from "@atproto/lex-data";
import {
	BlockMap,
	blocksToCarFile,
	writeCarStream,
	getRecords,
	type CarBlock,
} from "@atproto/repo";
import type { SqliteRepoStorage } from "./storage";

/**
 * Stream the full repository as a CAR file.
 * Takes the raw SqlStorage handle so blocks can be lazily iterated
 * instead of materialized in memory.
 */
export async function getRepoCar(
	sql: SqlStorage,
	storage: SqliteRepoStorage,
): Promise<Response> {
	const root = await storage.getRoot();

	if (!root) {
		return Response.json(
			{ error: "RepoNotFound", message: "No repository root found" },
			{ status: 404 },
		);
	}

	// Lazily iterate SQLite rows — the cursor is already lazy,
	// only .toArray() would materialize everything in memory.
	const cursor = sql.exec("SELECT cid, bytes FROM blocks");

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
 * Get specific blocks by CID as a CAR file.
 * Used for partial sync and migration.
 */
export async function getBlocksCar(
	storage: SqliteRepoStorage,
	cids: string[],
): Promise<Uint8Array> {
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
 * Get a record with proof as a CAR file.
 * Returns the commit block and all MST blocks needed to verify
 * the existence (or non-existence) of a record.
 * Used by com.atproto.sync.getRecord for record verification.
 */
export async function getRecordProofCar(
	storage: SqliteRepoStorage,
	collection: string,
	rkey: string,
): Promise<Uint8Array> {
	const root = await storage.getRoot();

	if (!root) {
		throw new Error("No repository root found");
	}

	// Use @atproto/repo's getRecords to generate the proof CAR
	// This returns an async iterable of CAR chunks
	const carChunks: Uint8Array[] = [];
	for await (const chunk of getRecords(storage, root, [{ collection, rkey }])) {
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
