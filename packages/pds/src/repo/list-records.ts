import type { Leaf, MST } from "@atproto/repo";

/**
 * List one page of a collection's MST leaves.
 *
 * Leaves come back newest first by default, as in the reference PDS, and
 * oldest first with `reverse`. The cursor is the rkey of the last leaf of the
 * previous page and is excluded from this one.
 *
 * MST.walkFrom() can't be used here: it yields its start key twice when that
 * key exists, and it only walks forwards.
 */
export async function listCollectionLeaves(
	mst: MST,
	collection: string,
	opts: { limit: number; cursor?: string; reverse?: boolean },
): Promise<Leaf[]> {
	const prefix = `${collection}/`;
	// Cursors used to be `collection/rkey`; accept those for clients that
	// are mid-pagination across an upgrade.
	const rkey = opts.cursor?.startsWith(prefix)
		? opts.cursor.slice(prefix.length)
		: opts.cursor;

	// Exclusive bounds. Record keys only use ASCII below DEL, so `prefix\x7f`
	// sorts after every key in the collection.
	let gt = prefix;
	let lt = `${prefix}\x7f`;
	if (rkey) {
		if (opts.reverse) gt = `${prefix}${rkey}`;
		else lt = `${prefix}${rkey}`;
	}

	const leaves: Leaf[] = [];
	if (opts.limit < 1) return leaves;
	for await (const leaf of walkRange(mst, gt, lt, !opts.reverse)) {
		leaves.push(leaf);
		if (leaves.length >= opts.limit) break;
	}
	return leaves;
}

/**
 * Yield the leaves with keys strictly between `gt` and `lt`, in key order or,
 * when `descending`, in reverse. A subtree holds only keys between the leaves
 * either side of it, so subtrees outside the range are never loaded.
 */
async function* walkRange(
	node: MST,
	gt: string,
	lt: string,
	descending: boolean,
): AsyncGenerator<Leaf> {
	const entries = await node.getEntries();
	if (descending) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.isLeaf()) {
				if (entry.key <= gt) return;
				if (entry.key < lt) yield entry;
			} else {
				const prev = entries[i - 1];
				if (prev?.isLeaf() && prev.key >= lt) continue;
				yield* walkRange(entry, gt, lt, descending);
			}
		}
	} else {
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (entry.isLeaf()) {
				if (entry.key >= lt) return;
				if (entry.key > gt) yield entry;
			} else {
				const next = entries[i + 1];
				if (next?.isLeaf() && next.key <= gt) continue;
				yield* walkRange(entry, gt, lt, descending);
			}
		}
	}
}
