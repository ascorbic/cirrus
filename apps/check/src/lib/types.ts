import type { Bytes, CidLink } from '@atcute/cbor';
import { isBytes, isCidLink } from '@atcute/cbor';

/**
 * commit object stored at the root of an atproto repository CAR.
 *
 * mirrors the `Commit` type in `@atcute/repo`. `prev` is normally `null` — a
 * non-null value here is the kind of "unexpected field value" this tool is built
 * to surface. we intentionally do *not* use `@atcute/repo`'s `isCommit()` as a
 * gate: it accepts `prev` as either `null` or a `CidLink`, so it would happily
 * pass over exactly the anomaly we're hunting.
 */
export interface Commit {
	version: 3;
	did: string;
	data: CidLink;
	rev: string;
	sig: Bytes;
	/** backwards-compat with v2; history bookkeeping is not required, so this is normally null */
	prev: CidLink | null;
}

/** is `value` a well-formed commit with all six expected fields present? */
export const isWellFormedCommit = (value: unknown): value is Commit => {
	if (value === null || typeof value !== 'object') return false;
	const obj = value as Record<string, unknown>;
	return (
		obj.version === 3 &&
		typeof obj.did === 'string' &&
		isCidLink(obj.data) &&
		typeof obj.rev === 'string' &&
		(obj.prev === null || isCidLink(obj.prev)) &&
		isBytes(obj.sig)
	);
};
