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
