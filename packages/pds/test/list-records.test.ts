import { describe, it, expect, beforeAll } from "vitest";
import { MST, MemoryBlockstore, cidForRecord } from "@atproto/repo";
import { listCollectionLeaves } from "../src/repo/list-records";

const COLLECTION = "app.bsky.graph.follow";
const COUNT = 340;

describe("listCollectionLeaves", () => {
	let mst: MST;
	let rkeys: string[];

	beforeAll(async () => {
		const cid = await cidForRecord({ test: true });
		mst = await MST.create(new MemoryBlockstore());
		rkeys = [];
		for (let i = 0; i < COUNT; i++) {
			const rkey = `3m${(1e10 + i * 7919).toString(36)}`;
			rkeys.push(rkey);
			mst = await mst.add(`${COLLECTION}/${rkey}`, cid);
		}
		rkeys.sort();
		// Neighbours that sort just before and just after the collection.
		for (const key of [
			"app.bsky.feed.post/3maaaaaaaaaaa",
			"app.bsky.graph.follow.ext/3maaaaaaaaaaa",
			"app.bsky.graph.followa/3maaaaaaaaaaa",
			"app.bsky.graph.listitem/3maaaaaaaaaaa",
		]) {
			mst = await mst.add(key, cid);
		}
		// Make sure the cases below cross subtree boundaries.
		expect(await mst.getLayer()).toBeGreaterThan(1);
	});

	async function pageThrough(limit: number, reverse: boolean) {
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let pages = 0; pages <= COUNT; pages++) {
			const leaves = await listCollectionLeaves(mst, COLLECTION, {
				limit,
				cursor,
				reverse,
			});
			seen.push(...leaves.map((l) => l.key.slice(COLLECTION.length + 1)));
			if (leaves.length < limit) return seen;
			cursor = seen[seen.length - 1];
		}
		throw new Error("pagination did not terminate");
	}

	it("pages newest first with no duplicates or gaps", async () => {
		const expected = [...rkeys].reverse();
		for (const limit of [1, 2, 3, 7, 50, 100, COUNT, COUNT + 1]) {
			expect(await pageThrough(limit, false)).toEqual(expected);
		}
	});

	it("pages oldest first with reverse", async () => {
		for (const limit of [1, 2, 3, 7, 50, 100, COUNT, COUNT + 1]) {
			expect(await pageThrough(limit, true)).toEqual(rkeys);
		}
	});

	it("excludes the cursor key and starts after a missing one", async () => {
		const cursor = rkeys[100]!;
		const before = await listCollectionLeaves(mst, COLLECTION, {
			limit: 2,
			cursor,
		});
		expect(before.map((l) => l.key)).toEqual([
			`${COLLECTION}/${rkeys[99]}`,
			`${COLLECTION}/${rkeys[98]}`,
		]);

		const after = await listCollectionLeaves(mst, COLLECTION, {
			limit: 2,
			cursor: `${cursor}0`,
			reverse: true,
		});
		expect(after.map((l) => l.key)).toEqual([
			`${COLLECTION}/${rkeys[101]}`,
			`${COLLECTION}/${rkeys[102]}`,
		]);
	});

	it("accepts the old collection/rkey cursor format", async () => {
		const leaves = await listCollectionLeaves(mst, COLLECTION, {
			limit: 1,
			cursor: `${COLLECTION}/${rkeys[10]}`,
			reverse: true,
		});
		expect(leaves.map((l) => l.key)).toEqual([`${COLLECTION}/${rkeys[11]}`]);
	});

	it("stays inside the collection", async () => {
		const first = await listCollectionLeaves(mst, COLLECTION, {
			limit: 1,
			cursor: rkeys[0],
		});
		expect(first).toEqual([]);

		const last = await listCollectionLeaves(mst, COLLECTION, {
			limit: 1,
			cursor: rkeys[COUNT - 1],
			reverse: true,
		});
		expect(last).toEqual([]);

		const missing = await listCollectionLeaves(mst, "app.bsky.graph.block", {
			limit: 10,
		});
		expect(missing).toEqual([]);
	});
});
