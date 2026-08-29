import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function indexStub() {
	return env.SPACES_INDEX.get(env.SPACES_INDEX.idFromName("spaces"));
}

const AUTHORITY = "did:web:operator.test";

let n = 0;
function entry(overrides: Record<string, unknown> = {}) {
	const skey = `idx${n++}x`;
	return {
		uri: `at://${AUTHORITY}/space/app.bsky.group/${skey}`,
		authority: AUTHORITY,
		type: "app.bsky.group",
		skey,
		isAuthority: true,
		...overrides,
	};
}

describe("SpaceIndexDurableObject", () => {
	it("registers pending, activates and lists", async () => {
		const stub = indexStub();
		const e = entry();
		await stub.rpcRegister(e);
		expect((await stub.rpcGet(e.uri))?.state).toBe("pending");

		await stub.rpcActivate(e.uri);
		expect((await stub.rpcGet(e.uri))?.state).toBe("active");

		const listed = await stub.rpcList({ limit: 100, state: "active" });
		expect(listed.spaces.map((s) => s.uri)).toContain(e.uri);
	});

	it("filters by type and authority", async () => {
		const stub = indexStub();
		const a = entry({ type: "app.bsky.personal" });
		a.uri = `at://${AUTHORITY}/space/app.bsky.personal/${a.skey}`;
		await stub.rpcRegister(a);
		await stub.rpcActivate(a.uri);

		const byType = await stub.rpcList({
			limit: 100,
			type: "app.bsky.personal",
		});
		expect(byType.spaces.every((s) => s.type === "app.bsky.personal")).toBe(
			true,
		);
		expect(byType.spaces.map((s) => s.uri)).toContain(a.uri);

		const byAuthority = await stub.rpcList({
			limit: 100,
			authority: "did:web:someone-else.test",
		});
		expect(byAuthority.spaces).toEqual([]);
	});

	it("re-registering an active entry keeps it active", async () => {
		const stub = indexStub();
		const e = entry();
		await stub.rpcRegister(e);
		await stub.rpcActivate(e.uri);
		await stub.rpcRegister(e);
		expect((await stub.rpcGet(e.uri))?.state).toBe("active");
	});

	it("marks deleted and counts stats", async () => {
		const stub = indexStub();
		const e = entry();
		await stub.rpcRegister(e);
		await stub.rpcActivate(e.uri);
		await stub.rpcMarkDeleted(e.uri);
		expect((await stub.rpcGet(e.uri))?.state).toBe("deleted");

		const stats = await stub.rpcStats();
		expect(stats.total).toBeGreaterThan(0);
		expect(stats.deleted).toBeGreaterThan(0);
	});

	it("tombstones stale pending entries on alarm, keeping them discoverable", async () => {
		const stub = indexStub();
		const stale = entry();
		await stub.rpcRegister(stale);
		// Backdate the pending entry past the TTL, then run the alarm.
		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec(
				"UPDATE space SET updated_at = ? WHERE uri = ?",
				new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
				stale.uri,
			);
			await instance.alarm();
		});
		// Not removed: the row is the only durable manifest reset has for
		// finding a space DO that was initialised but never activated.
		expect((await stub.rpcGet(stale.uri))?.state).toBe("deleted");
		const listed = await stub.rpcList({ limit: 1000 });
		expect(listed.spaces.map((s) => s.uri)).toContain(stale.uri);

		// A revived registration goes back to pending.
		await stub.rpcRegister(stale);
		expect((await stub.rpcGet(stale.uri))?.state).toBe("pending");
	});

	it("pages with a cursor", async () => {
		const stub = indexStub();
		for (let i = 0; i < 3; i++) {
			const e = entry();
			await stub.rpcRegister(e);
			await stub.rpcActivate(e.uri);
		}
		const page1 = await stub.rpcList({ limit: 2 });
		expect(page1.spaces).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		const page2 = await stub.rpcList({
			limit: 100,
			afterUri: page1.spaces[1]!.uri,
		});
		expect(page2.spaces.length).toBeGreaterThan(0);
		expect(
			page2.spaces.every((s) => s.uri > page1.spaces[1]!.uri),
		).toBe(true);
	});
});
