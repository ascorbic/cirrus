import { CID } from "@atproto/lex-data";
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
 * BlobStore manages blob storage in R2.
 * Blobs are stored with CID-based keys prefixed by the account's DID.
 */
export class BlobStore {
	constructor(
		private r2: R2Bucket,
		private did: string,
	) {}

	/**
	 * Upload a blob to R2 and return a BlobRef.
	 */
	async putBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		// Compute CID using SHA-256 (RAW codec)
		const cidObj = await createCid(CODEC_RAW, bytes);
		const cidStr = cidToString(cidObj);

		// Store in R2 with DID prefix for isolation
		const key = `${this.did}/${cidStr}`;
		await this.r2.put(key, bytes, {
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
	 * Retrieve a blob from R2 by CID.
	 */
	async getBlob(cid: CID): Promise<R2ObjectBody | null> {
		const key = `${this.did}/${cid.toString()}`;
		return this.r2.get(key);
	}

	/**
	 * Check if a blob exists in R2.
	 */
	async hasBlob(cid: CID): Promise<boolean> {
		const key = `${this.did}/${cid.toString()}`;
		const head = await this.r2.head(key);
		return head !== null;
	}
}
