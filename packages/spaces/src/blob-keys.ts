/**
 * R2 key layout for space blobs.
 *
 * A blob referenced by a record in a space lives at
 * `${did}/space/${spaceId}/${cid}` and is served only by the
 * credential-gated `com.atproto.space.getBlob`. The same blob referenced
 * from two spaces is stored twice: per-space prefixes make space deletion
 * and full reset a prefix delete with no cross-space reference counting.
 */

import { spaceId } from "./space-uri.js";

/**
 * Key for a staged (uploaded, not yet referenced) blob. Must match the
 * host's public blob layout: uploads land here and are promoted to their
 * serving key when a record write references them.
 */
export function stagedBlobKey(did: string, cid: string): string {
	return `${did}/staged/${cid}`;
}

/** Prefix holding every space blob for the account. */
export function spaceBlobRootPrefix(did: string): string {
	return `${did}/space/`;
}

/** Prefix holding one space's blobs. `id` comes from {@link spaceId}. */
export function spaceBlobPrefix(did: string, id: string): string {
	return `${did}/space/${id}/`;
}

/** Key for one blob in one space. */
export function spaceBlobKey(did: string, id: string, cid: string): string {
	return `${did}/space/${id}/${cid}`;
}

/** Convenience: key for a blob given the space URI rather than its id. */
export async function spaceBlobKeyForUri(
	did: string,
	spaceUri: string,
	cid: string,
): Promise<string> {
	return spaceBlobKey(did, await spaceId(spaceUri), cid);
}

/**
 * Copy a staged upload into a space's blob prefix. Idempotent; returns
 * whether the blob is now at its destination (false when it was neither
 * there nor staged).
 */
export async function promoteStagedBlobToSpace(
	bucket: R2Bucket,
	did: string,
	spaceUri: string,
	cid: string,
): Promise<boolean> {
	const destKey = await spaceBlobKeyForUri(did, spaceUri, cid);
	if (await bucket.head(destKey)) return true;
	const staged = await bucket.get(stagedBlobKey(did, cid));
	if (!staged) return false;
	await bucket.put(destKey, staged.body, { httpMetadata: staged.httpMetadata });
	return true;
}

/**
 * Promote a freshly uploaded blob into every space whose imported records
 * reference it (see `com.atproto.space.importRepo`). The host calls this
 * from `com.atproto.repo.uploadBlob`, mirroring how an imported public repo's
 * blobs are made permanent on upload.
 */
export async function promotePendingSpaceBlob(params: {
	bucket: R2Bucket;
	did: string;
	cid: string;
	claimPendingBlob: (cid: string) => Promise<string[]>;
}): Promise<number> {
	const uris = await params.claimPendingBlob(params.cid);
	for (const uri of uris) {
		await promoteStagedBlobToSpace(params.bucket, params.did, uri, params.cid);
	}
	return uris.length;
}
