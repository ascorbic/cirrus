import {
	create as createCid,
	CODEC_RAW,
	toString as cidToString,
} from "@atcute/cid";

export interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

/**
 * R2 key layout for blobs:
 *
 *   `${did}/staged/${cid}` – uploaded, not yet referenced by any record.
 *     Served by nothing; expired by an R2 lifecycle rule after seven days.
 *   `${did}/${cid}`        – referenced by at least one public record.
 *     Served by com.atproto.sync.getBlob.
 *
 * Uploads land in `staged/` and are promoted (copied) to their destination
 * key when a record write first references them. The copy completes before
 * the commit is applied, so anything reacting to the commit never sees a
 * 404. Keys never move back: promotion is idempotent and `staged/` copies
 * are left for the lifecycle rule to reap.
 */
function stagedBlobKey(did: string, cid: string): string {
	return `${did}/staged/${cid}`;
}

function publicBlobKey(did: string, cid: string): string {
	return `${did}/${cid}`;
}

/**
 * Extract blob CIDs from a record in JSON form (as received from clients),
 * recursively searching for blob references. Handles both the current
 * `{ $type: "blob", ref: { $link }, mimeType, size }` shape and the legacy
 * untyped `{ cid, mimeType }` shape.
 */
export function extractJsonBlobCids(value: unknown): string[] {
	const cids = new Set<string>();
	walkForBlobRefs(value, cids);
	return Array.from(cids);
}

function walkForBlobRefs(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) walkForBlobRefs(item, out);
		return;
	}
	if (value === null || typeof value !== "object") return;

	const obj = value as Record<string, unknown>;

	if (
		obj.$type === "blob" &&
		typeof obj.ref === "object" &&
		obj.ref !== null &&
		typeof (obj.ref as Record<string, unknown>).$link === "string"
	) {
		out.add((obj.ref as { $link: string }).$link);
		return;
	}

	// Legacy blob ref: { cid: string, mimeType: string } with no $type
	if (
		obj.$type === undefined &&
		typeof obj.cid === "string" &&
		typeof obj.mimeType === "string"
	) {
		out.add(obj.cid);
		return;
	}

	for (const key of Object.keys(obj)) {
		walkForBlobRefs(obj[key], out);
	}
}

/**
 * BlobStore manages blob storage in R2.
 * Blobs are stored with CID-based keys prefixed by the account's DID.
 */
export class BlobStore {
	constructor(
		private r2: R2Bucket,
		private did: string,
	) {}

	/**
	 * Upload a blob to R2 staging and return a BlobRef.
	 *
	 * The blob is not fetchable until a record write references it, which
	 * promotes it to its serving key.
	 */
	async putBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		// Compute CID using SHA-256 (RAW codec)
		const cidObj = await createCid(CODEC_RAW, bytes);
		const cidStr = cidToString(cidObj);

		await this.r2.put(stagedBlobKey(this.did, cidStr), bytes, {
			httpMetadata: { contentType: mimeType },
		});

		return {
			$type: "blob",
			ref: { $link: cidStr },
			mimeType,
			size: bytes.length,
		};
	}

	/**
	 * Promote a staged blob to a destination key with a streaming copy.
	 *
	 * Idempotent: returns early when the destination already exists, so
	 * concurrent writes referencing the same staged blob are safe. A CID
	 * that is neither staged nor at the destination is skipped — records
	 * may reference blobs from before this layout existed, and reference
	 * checking is not this method's job.
	 */
	private async promoteTo(cid: string, destKey: string): Promise<void> {
		if (await this.r2.head(destKey)) return;

		const staged = await this.r2.get(stagedBlobKey(this.did, cid));
		if (!staged) return;

		await this.r2.put(destKey, staged.body, {
			httpMetadata: staged.httpMetadata,
		});
	}

	/**
	 * Promote a staged blob to the public serving key.
	 */
	async promoteBlob(cid: string): Promise<void> {
		await this.promoteTo(cid, publicBlobKey(this.did, cid));
	}

	/**
	 * Promote several staged blobs to the public serving key.
	 */
	async promoteBlobs(cids: string[]): Promise<void> {
		await Promise.all(cids.map((cid) => this.promoteBlob(cid)));
	}

	/**
	 * Retrieve a public blob from R2 by CID string.
	 */
	async getBlob(cid: string): Promise<R2ObjectBody | null> {
		return this.r2.get(publicBlobKey(this.did, cid));
	}

	/**
	 * Check if a blob exists at the public serving key.
	 */
	async hasBlob(cid: string): Promise<boolean> {
		const head = await this.r2.head(publicBlobKey(this.did, cid));
		return head !== null;
	}
}
