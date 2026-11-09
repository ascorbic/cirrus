import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	COMMIT_MAC_TYPE,
	LtHash,
	RepoCommit,
	computeCommitMac,
	encapsulate,
	verifyCommit,
} from "@atproto/space";
import { P256Keypair } from "@atproto/crypto";
import { encode } from "@atproto/lex-cbor";
import { buildCommit, macSecret } from "../src/mac";
import type { PreparedSpaceWrite, SpacePolicy } from "../src/types";
import {
	TEST_KEM_KEY,
	TEST_OPERATOR_DID,
	type TestSpaceDurableObject,
} from "./fixtures/spaces-worker/index";

const MEMBERSPACE: SpacePolicy = {
	$type: "com.atproto.memberspace.policy",
	publicRead: false,
	publicWrite: false,
	publishPolicy: false,
	publishMembers: false,
};

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
		...(isAuthority ? { policy: MEMBERSPACE } : {}),
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
		expect(new Uint8Array(r1.data)).toEqual(expected.digest());

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
		expect(new Uint8Array(r2.data)).toEqual(expected.digest());

		// The persisted state round-trips through RepoCommit and matches.
		const state = await stub.rpcGetRepoState();
		expect(state?.rev).toBe(r2.rev);
		const commit = RepoCommit.fromState(new Uint8Array(state!.setHash));
		expect(commit.setHash.digest()).toEqual(expected.digest());
	});

	it("builds commits from persisted state whose MAC verifies", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const w = write("create", "mac", { $type: "app.bsky.feed.post", n: 9 });
		await stub.rpcApplyWrites([w]);

		const state = await stub.rpcGetRepoState();
		const commit = buildCommit({
			spaceUri: uri,
			repo: AUTHORITY,
			state: state!,
		});
		const kemDid = (await P256Keypair.import(TEST_KEM_KEY)).did();
		const { keyShare, sharedSecret } = await encapsulate(kemDid);
		const { formatWantMacHeader } = await import("@atproto/space");
		const hostSecret = await macSecret({
			wantMac: formatWantMacHeader(COMMIT_MAC_TYPE, keyShare),
			credential: true,
			type: COMMIT_MAC_TYPE,
			getKemKeypair: () => P256Keypair.import(TEST_KEM_KEY),
		});
		const mac = computeCommitMac(hostSecret!, commit as never);
		expect(
			verifyCommit(commit as never, {
				space: uri,
				repo: AUTHORITY,
				sharedSecret,
				mac,
			}),
		).toBe(true);
	});

	it("orders records by path bytes for archives", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcApplyWrites([
			{ ...write("create", "z", { n: 1 }), collection: "app.bsky.feed" },
			{ ...write("create", "a", { n: 2 }), collection: "app.bsky.feed.post" },
		]);
		const page = await stub.rpcListRecordsByPath({ limit: 1 });
		// "app.bsky.feed.post/a" < "app.bsky.feed/z" byte-wise ('.' < '/').
		expect(page.records.map((r) => r.collection)).toEqual([
			"app.bsky.feed.post",
		]);
		expect(page.hasMore).toBe(true);
		const next = await stub.rpcListRecordsByPath({
			afterPath: "app.bsky.feed.post/a",
			limit: 10,
		});
		expect(next.records.map((r) => r.collection)).toEqual(["app.bsky.feed"]);
		expect(next.state?.rev).toBe(page.state?.rev);
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

	it("manages members with read and write access", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcPutMember("did:web:bob.test", { read: true, write: false });
		await stub.rpcPutMember("did:web:carol.test", { read: true, write: true });
		expect(await stub.rpcGetMember("did:web:bob.test")).toEqual({
			did: "did:web:bob.test",
			read: true,
			write: false,
		});
		const members = await stub.rpcListMembers({ limit: 1 });
		expect(members.members.map((m) => m.did)).toEqual(["did:web:bob.test"]);
		expect(members.hasMore).toBe(true);
		await stub.rpcRemoveMember("did:web:bob.test");
		expect(await stub.rpcGetMember("did:web:bob.test")).toBe(null);
	});

	it("sequences writers by space revision, monotonic per writer", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const data = new Uint8Array(32).fill(7);
		const first = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3kzzzzzzzzzzz",
			data,
		);
		expect(first?.spaceRev).toMatch(/^[2-7a-z]{13}$/);
		expect(first?.prevSpaceRev).toBeUndefined();
		const second = await stub.rpcRecordWriter(
			"did:web:carol.test",
			"3kzzzzzzzzzzz",
			data,
		);
		expect(second?.prevSpaceRev).toBe(first?.spaceRev);
		expect(second!.spaceRev > first!.spaceRev).toBe(true);

		// A delayed or replayed notification with an older or equal rev never
		// rolls the writer set backwards, and reports that nothing advanced.
		expect(
			await stub.rpcRecordWriter("did:web:bob.test", "3kaaaaaaaaaaa", data),
		).toBe(null);
		expect(
			await stub.rpcRecordWriter("did:web:bob.test", "3kzzzzzzzzzzz", data),
		).toBe(null);

		// Bob advances again and moves to the end of the sequence.
		const third = await stub.rpcRecordWriter(
			"did:web:bob.test",
			"3lzzzzzzzzzzz",
			data,
		);
		expect(third?.prevSpaceRev).toBe(second?.spaceRev);
		const all = await stub.rpcListWriters({ limit: 10 });
		expect(all.map((w) => w.did)).toEqual([
			"did:web:carol.test",
			"did:web:bob.test",
		]);
		expect(all[1]).toMatchObject({
			repoRev: "3lzzzzzzzzzzz",
			spaceRev: third!.spaceRev,
		});
		const after = await stub.rpcListWriters({
			limit: 10,
			cursor: all[0]!.spaceRev,
		});
		expect(after.map((w) => w.did)).toEqual(["did:web:bob.test"]);

		await stub.rpcRemoveWriter("did:web:bob.test");
		expect(
			(await stub.rpcListWriters({ limit: 10 })).map((w) => w.did),
		).toEqual(["did:web:carol.test"]);
		// Revoking write access drops a member from the writer set.
		await stub.rpcPutMember("did:web:carol.test", { read: true, write: false });
		expect(await stub.rpcListWriters({ limit: 10 })).toEqual([]);
	});

	it("registers and unregisters notification services", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const reg = await stub.rpcRegisterNotify(
			"did:web:syncer.test",
			"https://syncer.test",
		);
		expect(Date.parse(reg.expiresAt)).toBeGreaterThan(Date.now());
		expect(await stub.rpcGetActiveRegistrations()).toEqual([
			{
				service: "did:web:syncer.test",
				endpoint: "https://syncer.test",
				expiresAt: reg.expiresAt,
			},
		]);
		await stub.rpcUnregisterNotify("did:web:syncer.test");
		expect(await stub.rpcGetActiveRegistrations()).toEqual([]);
		// Idempotent unregister.
		await stub.rpcUnregisterNotify("did:web:syncer.test");
	});

	it("replaces the policy, discarding members when its $type changes", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcPutMember("did:web:bob.test", { read: true, write: true });
		expect(
			await stub.rpcUpdatePolicy({ ...MEMBERSPACE, publicRead: true }),
		).toBe(null);
		expect((await stub.rpcGetAuthorityState()).policy).toMatchObject({
			publicRead: true,
		});
		expect(await stub.rpcGetMember("did:web:bob.test")).not.toBe(null);
		await stub.rpcUpdatePolicy({
			$type: "com.atproto.managedspace.policy",
			managingApp: "did:web:app.test#svc",
			publishPolicy: false,
		});
		expect(
			await rpcError(stub, (i) => i.rpcGetMember("did:web:bob.test")),
		).toBe("");
		expect(await stub.rpcGetMember("did:web:bob.test")).toBe(null);
		expect(await rpcError(stub, (i) => i.rpcListMembers({ limit: 1 }))).toMatch(
			/PolicyMismatch/,
		);
	});

	it("publishes the policy record on creation and withdraws it", async () => {
		const { uri, stub } = freshSpace();
		const commit = await stub.rpcInit({
			uri,
			authority: AUTHORITY,
			type: "app.bsky.group",
			skey: uri.split("/").pop()!,
			isAuthority: true,
			policy: { ...MEMBERSPACE, publishPolicy: true },
		});
		expect(commit?.rev).toMatch(/^[2-7a-z]{13}$/);
		expect(
			await stub.rpcGetRecord("com.atproto.space.policy", "self"),
		).not.toBe(null);
		const withdrawn = await stub.rpcUpdatePolicy(MEMBERSPACE);
		expect(withdrawn?.rev && withdrawn.rev > commit!.rev).toBe(true);
		expect(await stub.rpcGetRecord("com.atproto.space.policy", "self")).toBe(
			null,
		);
	});

	it("clears records, keeping the given collections", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		await stub.rpcApplyWrites([
			write("create", "a", { n: 1 }),
			{
				...write("create", "self", { n: 2 }),
				collection: "com.atproto.space.policy",
			},
		]);
		const cleared = await stub.rpcClearRecords(["com.atproto.space.policy"]);
		const remaining = await stub.rpcListRecords({ limit: 10 });
		expect(remaining.records.map((r) => r.collection)).toEqual([
			"com.atproto.space.policy",
		]);
		const expected = new LtHash().add(
			`com.atproto.space.policy/self/${remaining.records[0]!.cid}`,
		);
		expect(new Uint8Array(cleared!.data)).toEqual(expected.digest());
		expect((await stub.rpcListRepoOps({ limit: 10 })).ops).toEqual([]);
		// Nothing left to delete: a no-op.
		expect(await stub.rpcClearRecords(["com.atproto.space.policy"])).toBe(null);
	});

	it("imports a repo wholesale at a new rev", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const before = await stub.rpcApplyWrites([
			write("create", "old", { n: 1 }),
		]);
		const imported = write("create", "new", { n: 2 }, ["bafkblob"]);
		const result = await stub.rpcImportRepo([
			{
				collection: imported.collection,
				rkey: imported.rkey,
				cid: imported.cid,
				bytes: imported.bytes,
				blobCids: imported.blobCids,
			},
		]);
		expect(result.rev > before.rev).toBe(true);
		expect(await stub.rpcGetRecord("app.bsky.feed.post", "old")).toBe(null);
		expect(await stub.rpcHasSpaceBlob("bafkblob")).toBe(true);
		expect((await stub.rpcListRepoOps({ limit: 10 })).ops).toEqual([]);
		expect(new Uint8Array(result.data)).toEqual(
			new LtHash().add(`app.bsky.feed.post/new/${imported.cid}`).digest(),
		);
	});

	it("records revoked credentials until they expire", async () => {
		const { stub } = freshSpace();
		const now = Math.floor(Date.now() / 1000);
		await stub.rpcRevokeCredentials(["live", "lapsed"], now + 60);
		expect(await stub.rpcIsCredentialRevoked("live")).toBe(true);
		expect(await stub.rpcIsCredentialRevoked("other")).toBe(false);
		await stub.rpcRevokeCredentials(["lapsed"], now - 1);
		expect(await stub.rpcIsCredentialRevoked("lapsed")).toBe(false);
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
					policy: MEMBERSPACE,
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
		expect(state.policy).toBe(null);
		// Idempotent delete.
		expect((await stub.rpcDeleteSpace()).registrations).toEqual([]);

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

	it("coalesces keyed notifications and stops on deadlines and permanent refusals", async () => {
		const { uri, stub } = freshSpace();
		await initSpace(stub, uri);
		const statuses: number[] = [];
		await runInDurableObject(stub, async (instance) => {
			let next = 503;
			(globalThis as { fetch: typeof fetch }).fetch = (async () => {
				statuses.push(next);
				return new Response("{}", { status: next });
			}) as typeof fetch;
			const item = (rev: string) => ({
				service: "did:web:authority.test",
				endpoint: "https://authority.test",
				lxm: "com.atproto.space.notifyWrite",
				body: { repoRev: rev },
				coalesceKey: "notifyWrite:authority",
				deadline: Date.now() + 60_000,
			});
			await instance.rpcEnqueueNotify([item("1")]);
			await instance.rpcEnqueueNotify([item("2")]);
			expect((await instance.rpcStatus()).queuedNotifications).toBe(1);

			// Retryable: kept, with backoff.
			await instance.alarm();
			expect((await instance.rpcStatus()).queuedNotifications).toBe(1);

			// A permanent refusal is not retried.
			next = 400;
			await instance.rpcEnqueueNotify([item("3")]);
			await instance.alarm();
			expect((await instance.rpcStatus()).queuedNotifications).toBe(0);

			// A passed deadline drops the item undelivered.
			await instance.rpcEnqueueNotify([
				{ ...item("4"), deadline: Date.now() - 1 },
			]);
			await instance.alarm();
			expect((await instance.rpcStatus()).queuedNotifications).toBe(0);
		});
		expect(statuses).toEqual([503, 400]);
	});
});
