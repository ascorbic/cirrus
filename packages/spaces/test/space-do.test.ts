import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LtHash, RepoCommit, verifyCommit } from "@atproto/space";
import { Secp256k1Keypair } from "@atproto/crypto";
import { encode } from "@atproto/lex-cbor";
import type { PreparedSpaceWrite } from "../src/types";
import {
	TEST_OPERATOR_DID,
	TEST_SIGNING_KEY,
	type TestSpaceDurableObject,
} from "./fixtures/spaces-worker/index";

const AUTHORITY = TEST_OPERATOR_DID;

/**
 * Run an RPC method expected to throw and return its error message. The
 * error is caught inside the DO isolate: a rejected RPC stub promise is
 * double-reported by the workers pool as an unhandled rejection even when
 * the client handles it, so crossing the boundary with the rejection would
 * fail the run.
 */
async function rpcError(
	stub: DurableObjectStub<TestSpaceDurableObject>,
	fn: (instance: TestSpaceDurableObject) => Promise<unknown>,
): Promise<string> {
	return runInDurableObject(stub, async (instance) => {
		try {
			await fn(instance);
			return "";
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	});
}

let spaceCounter = 0;
function freshSpace(): {
	uri: string;
	stub: DurableObjectStub<TestSpaceDurableObject>;
} {
	const uri = `at://${AUTHORITY}/space/app.bsky.group/space${spaceCounter++}x`;
	const stub = env.SPACES.get(env.SPACES.idFromName(uri));
	return { uri, stub };
}

async function initSpace(
	stub: DurableObjectStub<TestSpaceDurableObject>,
	uri: string,
	isAuthority = true,
): Promise<void> {
	await stub.rpcInit({
		uri,
		authority: AUTHORITY,
		type: "app.bsky.group",
		skey: uri.split("/").pop()!,
		isAuthority,
		...(isAuthority
			? {
					config: {
						policy: { kind: "member-list" as const },
						appAccess: { kind: "open" as const },
					},
				}
			: {}),
	});
}

function write(
	action: "create" | "update",
	rkey: string,
	value: Record<string, unknown>,
	blobCids: string[] = [],
): PreparedSpaceWrite & { cid: string } {
	const bytes = encode(value);
	// A stable fake CID string is fine for engine tests: the DO treats CIDs
	// as opaque strings. Uniqueness per value is what matters.
	const cid = `bafyfake${rkey}${String(bytes.length)}${String(value.n ?? "")}`;
	return {
		action,
		collection: "app.bsky.feed.post",
		rkey,
		cid,
		bytes,
		blobCids,
	};
}

describe("SpaceDurableObject", () => {
	it("initialises and reports meta", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const meta = await stub.rpcGetMeta();
		expect(meta).toMatchObject({
			uri,
			authority: AUTHORITY,
			type: "app.bsky.group",
			isAuthority: true,
			deletedAt: null,
		});
	});

	it("applies create, update and delete with a consistent LtHash", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);

		const w1 = write("create", "aaa", { $type: "app.bsky.feed.post", n: 1 });
		const w2 = write("create", "bbb", { $type: "app.bsky.feed.post", n: 2 });
		const r1 = await stub.rpcApplyWrites([w1, w2]);
		expect(r1.results).toHaveLength(2);
		expect(r1.rev).toMatch(/^[2-7a-z]{13}$/);

		// Recompute the expected LtHash from the element strings.
		const expected = new LtHash();
		expected.add(`app.bsky.feed.post/aaa/${w1.cid}`);
		expected.add(`app.bsky.feed.post/bbb/${w2.cid}`);
		expect(new Uint8Array(r1.hash)).toEqual(expected.digest());

		// Update aaa and delete bbb.
		const w3 = write("update", "aaa", { $type: "app.bsky.feed.post", n: 3 });
		const r2 = await stub.rpcApplyWrites([
			w3,
			{ action: "delete", collection: "app.bsky.feed.post", rkey: "bbb" },
		]);
		expect(r2.rev > r1.rev).toBe(true);

		expected.remove(`app.bsky.feed.post/aaa/${w1.cid}`);
		expected.add(`app.bsky.feed.post/aaa/${w3.cid}`);
		expected.remove(`app.bsky.feed.post/bbb/${w2.cid}`);
		expect(new Uint8Array(r2.hash)).toEqual(expected.digest());

		// The persisted state round-trips through RepoCommit and matches.
		const state = await stub.rpcGetRepoState();
		expect(state?.rev).toBe(r2.rev);
		const commit = RepoCommit.fromState(new Uint8Array(state!.setHash));
		expect(commit.setHash.digest()).toEqual(expected.digest());
	});

	it("signs verifiable commits from persisted state", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const w = write("create", "sig", { $type: "app.bsky.feed.post", n: 9 });
		await stub.rpcApplyWrites([w]);

		const state = await stub.rpcGetRepoState();
		const keypair = await Secp256k1Keypair.import(TEST_SIGNING_KEY);
		const ctx = { space: uri, author: AUTHORITY, rev: state!.rev };
		const signed = await RepoCommit.fromState(
			new Uint8Array(state!.setHash),
		).sign(ctx, keypair);
		expect(await verifyCommit(signed, ctx, keypair.did())).toBe(true);
	});

	it("rejects duplicate creates and missing updates/deletes", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const w = write("create", "dup", { $type: "app.bsky.feed.post", n: 1 });
		await stub.rpcApplyWrites([w]);
		expect(await rpcError(stub, (i) => i.rpcApplyWrites([w]))).toMatch(
			/RecordAlreadyExists/,
		);
		expect(
			await rpcError(stub, (i) =>
				i.rpcApplyWrites([
					write("update", "missing", { $type: "app.bsky.feed.post" }),
				]),
			),
		).toMatch(/RecordNotFound/);
		expect(
			await rpcError(stub, (i) =>
				i.rpcApplyWrites([
					{ action: "delete", collection: "app.bsky.feed.post", rkey: "nope" },
				]),
			),
		).toMatch(/RecordNotFound/);
	});

	it("a failed batch applies nothing", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const ok = write("create", "keep", { $type: "app.bsky.feed.post", n: 1 });
		await stub.rpcApplyWrites([ok]);
		const before = await stub.rpcGetRepoState();

		expect(
			await rpcError(stub, (i) =>
				i.rpcApplyWrites([
					write("create", "newone", { $type: "app.bsky.feed.post", n: 2 }),
					ok, // duplicate create -> whole batch fails
				]),
			),
		).toMatch(/RecordAlreadyExists/);

		const after = await stub.rpcGetRepoState();
		expect(after?.rev).toBe(before?.rev);
		expect(new Uint8Array(after!.setHash)).toEqual(
			new Uint8Array(before!.setHash),
		);
		expect(await stub.rpcGetRecord("app.bsky.feed.post", "newone")).toBe(null);
	});

	it("returns records and pages listRecords descending by default", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		for (const rkey of ["aaa", "bbb", "ccc"]) {
			await stub.rpcApplyWrites([
				write("create", rkey, { $type: "app.bsky.feed.post", rkey }),
			]);
		}
		const rec = await stub.rpcGetRecord("app.bsky.feed.post", "bbb");
		expect(rec).not.toBe(null);

		const page1 = await stub.rpcListRecords({ limit: 2 });
		expect(page1.records.map((r) => r.rkey)).toEqual(["ccc", "bbb"]);
		expect(page1.hasMore).toBe(true);
		const page2 = await stub.rpcListRecords({
			limit: 2,
			after: { collection: "app.bsky.feed.post", rkey: "bbb" },
		});
		expect(page2.records.map((r) => r.rkey)).toEqual(["aaa"]);
		expect(page2.hasMore).toBe(false);

		const asc = await stub.rpcListRecords({ limit: 10, reverse: true });
		expect(asc.records.map((r) => r.rkey)).toEqual(["aaa", "bbb", "ccc"]);

		const meta = await stub.rpcListRecords({ limit: 10, excludeValues: true });
		expect(meta.records[0]?.bytes).toBeUndefined();
	});

	it("serves the oplog with values, cursors and head state", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const w1 = write("create", "one", { $type: "app.bsky.feed.post", n: 1 });
		const w2 = write("create", "two", { $type: "app.bsky.feed.post", n: 2 });
		const r1 = await stub.rpcApplyWrites([w1, w2]);
		const w3 = write("update", "one", { $type: "app.bsky.feed.post", n: 3 });
		const r2 = await stub.rpcApplyWrites([w3]);

		// Full log from the start reaches the head: ops + head state.
		const all = await stub.rpcListRepoOps({ limit: 100 });
		expect(all.ops).toHaveLength(3);
		expect(all.head?.rev).toBe(r2.rev);
		// The create of "one" was superseded: no value. The create of "two"
		// and the update of "one" are current: values inlined.
		const [op1, op2, op3] = all.ops;
		expect(op1?.cid).toBe(w1.cid);
		expect(op1?.bytes).toBeUndefined();
		expect(op2?.bytes).not.toBeUndefined();
		expect(op3?.cid).toBe(w3.cid);
		expect(op3?.prev).toBe(w1.cid);
		expect(op3?.bytes).not.toBeUndefined();

		// since filters by rev; a full page withholds head.
		const sinceR1 = await stub.rpcListRepoOps({ since: r1.rev, limit: 100 });
		expect(sinceR1.ops).toHaveLength(1);
		expect(sinceR1.ops[0]?.rev).toBe(r2.rev);

		const paged = await stub.rpcListRepoOps({ limit: 2 });
		expect(paged.ops).toHaveLength(2);
		expect(paged.head).toBeUndefined();
		const rest = await stub.rpcListRepoOps({
			after: { rev: paged.ops[1]!.rev, idx: paged.ops[1]!.idx },
			limit: 2,
		});
		expect(rest.ops).toHaveLength(1);
		expect(rest.head?.rev).toBe(r2.rev);
	});

	it("tracks blob references per record", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcApplyWrites([
			write("create", "withblob", { $type: "app.bsky.feed.post" }, [
				"bafblob1",
				"bafblob2",
			]),
		]);
		expect(await stub.rpcHasSpaceBlob("bafblob1")).toBe(true);
		expect(await stub.rpcHasSpaceBlob("bafother")).toBe(false);

		const blobs = await stub.rpcListBlobs({ limit: 10 });
		expect(blobs.cids.sort()).toEqual(["bafblob1", "bafblob2"]);

		// Updating the record to drop a blob removes the reference.
		await stub.rpcApplyWrites([
			write("update", "withblob", { $type: "app.bsky.feed.post", n: 2 }, [
				"bafblob1",
			]),
		]);
		expect(await stub.rpcHasSpaceBlob("bafblob2")).toBe(false);
	});

	it("enforces single-use replay keys", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const exp = Math.floor(Date.now() / 1000) + 60;
		expect(await stub.rpcCheckReplay("dpop", "jti-1", exp)).toBe(true);
		expect(await stub.rpcCheckReplay("dpop", "jti-1", exp)).toBe(false);
		expect(await stub.rpcCheckReplay("delegation", "jti-1", exp)).toBe(true);
	});

	it("manages members, writers and notify registrations", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcAddMember("did:web:bob.test");
		await stub.rpcAddMember("did:web:carol.test");
		expect(await stub.rpcIsMember("did:web:bob.test")).toBe(true);
		const members = await stub.rpcListMembers({ limit: 10 });
		expect(members.dids).toEqual(["did:web:bob.test", "did:web:carol.test"]);
		await stub.rpcRemoveMember("did:web:bob.test");
		expect(await stub.rpcIsMember("did:web:bob.test")).toBe(false);

		const hash = new Uint8Array(32).fill(7);
		const first = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3kzzzzzzzzzzz",
			hash,
		);
		expect(first.advanced).toBe(true);
		const writers = await stub.rpcListWriters({ limit: 10 });
		expect(writers.repos).toHaveLength(1);
		expect(writers.repos[0]).toMatchObject({
			did: "did:web:bob.test",
			rev: "3kzzzzzzzzzzz",
		});
		expect(new Uint8Array(writers.repos[0]!.hash)).toEqual(hash);

		// A delayed or replayed notification with an older rev never rolls
		// the writer set backwards, and reports that nothing advanced.
		const staleHash = new Uint8Array(32).fill(9);
		const stale = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3kaaaaaaaaaaa",
			staleHash,
		);
		expect(stale.advanced).toBe(false);
		const equal = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3kzzzzzzzzzzz",
			staleHash,
		);
		expect(equal.advanced).toBe(false);
		const unchanged = await stub.rpcListWriters({ limit: 10 });
		expect(unchanged.repos[0]).toMatchObject({ rev: "3kzzzzzzzzzzz" });
		expect(new Uint8Array(unchanged.repos[0]!.hash)).toEqual(hash);

		// A newer rev advances again.
		const newer = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3lzzzzzzzzzzz",
			staleHash,
		);
		expect(newer.advanced).toBe(true);
		const advancedState = await stub.rpcListWriters({ limit: 10 });
		expect(advancedState.repos[0]).toMatchObject({ rev: "3lzzzzzzzzzzz" });

		const reg = await stub.rpcRegisterNotify(
			"did:web:syncer.test",
			"https://syncer.test",
		);
		expect(Date.parse(reg.expiresAt)).toBeGreaterThan(Date.now());
		expect(await stub.rpcGetActiveRegistrations()).toEqual([
			{ service: "did:web:syncer.test", endpoint: "https://syncer.test" },
		]);
		await stub.rpcUnregisterNotify("did:web:syncer.test");
		expect(await stub.rpcGetActiveRegistrations()).toEqual([]);
		// Idempotent unregister.
		await stub.rpcUnregisterNotify("did:web:syncer.test");
	});

	it("updates and reads simplespace config", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const s1 = await stub.rpcGetAuthorityState();
		expect(s1.config).toEqual({
			policy: { kind: "member-list" },
			appAccess: { kind: "open" },
		});
		await stub.rpcUpdateConfig({
			policy: { kind: "managing-app", managingApp: "did:web:app.test#svc" },
		});
		const s2 = await stub.rpcGetAuthorityState();
		expect(s2.config?.policy).toEqual({
			kind: "managing-app",
			managingApp: "did:web:app.test#svc",
		});
		// appAccess untouched by partial update.
		expect(s2.config?.appAccess).toEqual({ kind: "open" });
		await stub.rpcUpdateConfig({
			appAccess: { kind: "allowList", allowed: ["https://app.test/client"] },
		});
		const s3 = await stub.rpcGetAuthorityState();
		expect(s3.config?.appAccess).toEqual({
			kind: "allowList",
			allowed: ["https://app.test/client"],
		});
	});

	it("createSpace conflicts on a live space and revives a deleted one", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		expect(
			await rpcError(stub, (i) =>
				i.rpcInit({
					uri,
					authority: AUTHORITY,
					type: "app.bsky.group",
					skey: uri.split("/").pop()!,
					isAuthority: true,
					config: {
						policy: { kind: "member-list" },
						appAccess: { kind: "open" },
					},
				}),
			),
		).toMatch(/SpaceAlreadyExists/);

		await stub.rpcApplyWrites([
			write("create", "gone", { $type: "app.bsky.feed.post" }),
		]);
		const del = await stub.rpcDeleteSpace();
		expect(del.registrations).toEqual([]);

		// Tombstone: reads fail SpaceNotFound, authority state shows deleted.
		expect(
			await rpcError(stub, (i) => i.rpcGetRecord("app.bsky.feed.post", "gone")),
		).toMatch(/SpaceNotFound/);
		const state = await stub.rpcGetAuthorityState();
		expect(state.meta?.deletedAt).not.toBe(null);
		expect(state.config).toBe(null);
		// Idempotent delete.
		const again = await stub.rpcDeleteSpace();
		expect(again.registrations).toEqual([]);

		// Re-creation revives with a clean slate.
		await initSpace(stub, uri);
		const revived = await stub.rpcGetAuthorityState();
		expect(revived.meta?.deletedAt).toBe(null);
		expect(await stub.rpcGetRecord("app.bsky.feed.post", "gone")).toBe(null);
	});

	it("refuses every RPC when the stored schema version is outdated", async () => {
		const { uri, stub } = freshSpace();
		// Prepare a meta table from a "different alpha build" before the
		// engine ever initialises this DO.
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(`
				CREATE TABLE meta (
					uri TEXT, authority TEXT, type TEXT, skey TEXT,
					is_authority INTEGER, created_at TEXT, deleted_at TEXT,
					schema_version INTEGER
				)
			`);
			state.storage.sql.exec(
				"INSERT INTO meta (uri, schema_version) VALUES (?, ?)",
				uri,
				999,
			);
		});

		expect(await rpcError(stub, (i) => i.rpcGetMeta())).toMatch(
			/SpacesSchemaOutdated/,
		);
		expect(
			await rpcError(stub, (i) =>
				i.rpcApplyWrites([
					write("create", "x", { $type: "app.bsky.feed.post" }),
				]),
			),
		).toMatch(/SpacesSchemaOutdated/);
		const status = await stub.rpcStatus();
		expect(status.outdated).toBe(true);

		// Reset wipes it back to a usable state.
		await stub.rpcDestroy();
		await initSpace(stub, uri);
		expect((await stub.rpcGetMeta())?.uri).toBe(uri);
	});

	it("enqueues notifications and delivers them from the alarm", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);

		const delivered: Array<{ url: string; auth: string | null; body: string }> =
			[];
		await runInDurableObject(stub, async (instance) => {
			// Intercept outbound fetch from the DO.
			(globalThis as { fetch: typeof fetch }).fetch = (async (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => {
				const headers = new Headers(init?.headers);
				delivered.push({
					url: String(input),
					auth: headers.get("Authorization"),
					body: String(init?.body),
				});
				return new Response("{}", { status: 200 });
			}) as typeof fetch;

			await instance.rpcEnqueueNotify([
				{
					service: "did:web:syncer.test",
					endpoint: "https://syncer.test",
					lxm: "com.atproto.space.notifyWrite",
					body: { space: uri, repo: AUTHORITY, rev: "3kaaaaaaaaaa2" },
				},
			]);
			await instance.alarm();
		});

		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.url).toBe(
			"https://syncer.test/xrpc/com.atproto.space.notifyWrite",
		);
		expect(delivered[0]!.auth).toMatch(/^Bearer /);
		expect(JSON.parse(delivered[0]!.body)).toMatchObject({ space: uri });

		// Queue is drained.
		const status = await stub.rpcStatus();
		expect(status.queuedNotifications).toBe(0);
	});
});
