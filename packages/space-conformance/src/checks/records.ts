/**
 * Record writes and the owner's own reads: create/put/delete/applyWrites,
 * clearRecords, listRecords, blobs, and the SpaceNotFound perimeter around
 * spaces that do not exist or were deleted. Operator-only, browser-safe.
 */

import { defineCheck } from "../registry.js";
import {
	asOperator,
	operatorFetch,
	xrpcGet,
	xrpcPost,
	type XrpcResult,
} from "../http.js";
import { fail, pass, type Check, type CheckContext } from "../model.js";
import { bytesEqual, lexBytes, rawCid, sha256 } from "../encoding.js";
import {
	POST,
	createProbeSpace,
	deleteProbeSpace,
	describe,
	memberspace,
	mustCreateRecord,
	note,
	operatorCreateRecord,
	operatorGetRecord,
	personalspace,
	unknownSpaceUri,
} from "./probe.js";

const L = (ref: string) => ({ source: "lexicon" as const, ref });
const C = (ref: string) => ({ source: "changeset" as const, ref });
const op = asOperator;

const writesCreateRead = defineCheck({
	id: "writes.create-and-read",
	title: "Operator creates a record and reads it back",
	tier: "must",
	citations: [
		L("com.atproto.space.createRecord"),
		L("com.atproto.space.getRecord"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const created = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"rec1",
				note("hello"),
			);
			if (created.status !== 200)
				return fail(`createRecord ${describe(created)}`, created.json);
			const read = await operatorGetRecord(ctx, space.uri, "rec1");
			if (read.status !== 200)
				return fail(`getRecord ${describe(read)}`, read.json);
			const body = read.json as {
				uri?: string;
				cid?: string;
				value?: { text?: string };
			};
			if (body.cid !== (created.json as { cid?: string }).cid) {
				return fail(
					"getRecord cid differs from the createRecord cid",
					read.json,
				);
			}
			return body.value?.text === "hello"
				? pass("round-tripped the record value and cid")
				: fail("record value did not round-trip", read.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesUnauthReadRefused = defineCheck({
	id: "auth.existing-record-unauth-refused",
	title: "An existing space record is not readable without auth",
	tier: "must",
	citations: [L("com.atproto.space.getRecord")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The browser-safe auth.getrecord-unauthenticated-refused can only
		// probe a *nonexistent* space, so on its own it cannot distinguish a
		// host that enforces auth from one that 401s missing spaces but serves
		// existing records to anyone. This is the other half.
		const space = await createProbeSpace(ctx);
		try {
			await mustCreateRecord(ctx, space.uri, "private", "not for you");
			const res = await xrpcGet(ctx, "com.atproto.space.getRecord", {
				space: space.uri,
				repo: ctx.target.did,
				collection: POST,
				rkey: "private",
			});
			if (res.status === 200)
				return fail(
					"an existing space record was served with no auth",
					res.json,
				);
			return res.status === 401 || res.status === 403
				? pass(`unauthenticated read of a real record refused (${res.status})`)
				: fail(
						`refused, but with ${describe(res)} rather than 401/403`,
						res.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesDuplicate = defineCheck({
	id: "writes.duplicate-rejected",
	title: "A second create at the same key is refused with RecordAlreadyExists",
	tier: "must",
	citations: [L("com.atproto.space.createRecord@error:RecordAlreadyExists")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await mustCreateRecord(ctx, space.uri, "dup", "one");
			const second = await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"dup",
				note("two"),
			);
			if (second.status === 200) return fail("duplicate create returned 200");
			return second.error === "RecordAlreadyExists"
				? pass("refused with RecordAlreadyExists")
				: fail(`refused but error was ${describe(second)}`, second.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesPutRecord = defineCheck({
	id: "writes.putrecord-upsert",
	title: "putRecord creates a record and then replaces it",
	tier: "must",
	citations: [L("com.atproto.space.putRecord")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		const put = (text: string) =>
			xrpcPost(op(ctx), "com.atproto.space.putRecord", {
				space: space.uri,
				repo: ctx.target.did,
				collection: POST,
				rkey: "upsert",
				record: note(text),
			});
		try {
			const first = await put("v1");
			if (first.status !== 200)
				return fail(`putRecord (create) ${describe(first)}`, first.json);
			const second = await put("v2");
			if (second.status !== 200)
				return fail(`putRecord (update) ${describe(second)}`, second.json);
			const read = await operatorGetRecord(ctx, space.uri, "upsert");
			const text = (read.json as { value?: { text?: string } } | undefined)
				?.value?.text;
			return text === "v2"
				? pass("created then replaced the record")
				: fail(
						`after two puts the record reads ${describe(read)} ${text}`,
						read.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesGetRecordMissing = defineCheck({
	id: "writes.getrecord-missing",
	title: "getRecord of an absent rkey answers RecordNotFound",
	tier: "must",
	citations: [L("com.atproto.space.getRecord@error:RecordNotFound")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			// The repo exists (one record), so the absence is the record's.
			await mustCreateRecord(ctx, space.uri, "present");
			const res = await operatorGetRecord(ctx, space.uri, "absent");
			return res.error === "RecordNotFound"
				? pass("answered RecordNotFound")
				: fail(`answered ${describe(res)}, expected RecordNotFound`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesDeleteIdempotent = defineCheck({
	id: "writes.delete-idempotent",
	title: "deleteRecord removes the record and is idempotent",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteRecord"),
		L("com.atproto.space.getRecord"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const del = (rkey: string) =>
				xrpcPost(op(ctx), "com.atproto.space.deleteRecord", {
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey,
				});
			// Effect first: without it a deleteRecord that is a no-op (200,
			// nothing happens) would pass on idempotency alone.
			await mustCreateRecord(ctx, space.uri, "doomed", "bye");
			const removed = await del("doomed");
			if (removed.status !== 200)
				return fail(
					`delete of an existing record returned ${describe(removed)}`,
					removed.json,
				);
			const after = await operatorGetRecord(ctx, space.uri, "doomed");
			if (after.status === 200)
				return fail("a deleted record was still readable", after.json);
			const again = await del("doomed");
			const ghost = await del("ghost");
			if (again.status !== 200 || ghost.status !== 200) {
				return fail(
					`repeat delete returned ${describe(again)}, absent-key delete returned ${describe(ghost)}`,
					{
						again: again.json,
						ghost: ghost.json,
					},
				);
			}
			return pass("delete removed the record; repeat and absent deletes 200");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const create = (rkey: string, text: string) => ({
	$type: "com.atproto.space.applyWrites#create",
	collection: POST,
	rkey,
	value: note(text),
});

const writesApplyWritesAtomic = defineCheck({
	id: "writes.applywrites-atomic",
	title: "A failing applyWrites batch commits nothing",
	tier: "must",
	citations: [
		L("com.atproto.space.applyWrites"),
		L("com.atproto.space.applyWrites@error:RecordAlreadyExists"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await mustCreateRecord(ctx, space.uri, "exists", "here");
			// Positive control: a target with no applyWrites at all would
			// otherwise pass the rollback assertion vacuously.
			const ok = await xrpcPost(op(ctx), "com.atproto.space.applyWrites", {
				space: space.uri,
				repo: ctx.target.did,
				writes: [create("ok1", "1"), create("ok2", "2")],
			});
			if (ok.status !== 200)
				return fail(
					`applyWrites did not accept a valid batch (${describe(ok)})`,
					ok.json,
				);
			const batch = await xrpcPost(op(ctx), "com.atproto.space.applyWrites", {
				space: space.uri,
				repo: ctx.target.did,
				writes: [create("fresh", "new"), create("exists", "collide")],
			});
			if (batch.status === 200) return fail("colliding batch returned 200");
			if (batch.error !== "RecordAlreadyExists") {
				return fail(
					`colliding batch refused with ${describe(batch)}, expected RecordAlreadyExists`,
					batch.json,
				);
			}
			const check = await operatorGetRecord(ctx, space.uri, "fresh");
			return check.status !== 200
				? pass("a failed batch committed nothing")
				: fail("a failed batch left its first op committed", check.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesApplyWritesMissing = defineCheck({
	id: "writes.applywrites-update-missing",
	title: "An applyWrites update of an absent record answers RecordNotFound",
	tier: "must",
	citations: [L("com.atproto.space.applyWrites@error:RecordNotFound")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await mustCreateRecord(ctx, space.uri, "present");
			const res = await xrpcPost(op(ctx), "com.atproto.space.applyWrites", {
				space: space.uri,
				repo: ctx.target.did,
				writes: [
					{
						$type: "com.atproto.space.applyWrites#update",
						collection: POST,
						rkey: "absent",
						value: note("nope"),
					},
				],
			});
			return res.error === "RecordNotFound"
				? pass("refused with RecordNotFound")
				: fail(`answered ${describe(res)}, expected RecordNotFound`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

/** The creating writes, each aimed at `space` (deleteRecord has its own check). */
function writeProbes(ctx: CheckContext, space: string) {
	const repo = ctx.target.did;
	return [
		[
			"createRecord",
			() =>
				xrpcPost(op(ctx), "com.atproto.space.createRecord", {
					space,
					repo,
					collection: POST,
					rkey: "w",
					record: note("w"),
				}),
		],
		[
			"putRecord",
			() =>
				xrpcPost(op(ctx), "com.atproto.space.putRecord", {
					space,
					repo,
					collection: POST,
					rkey: "w",
					record: note("w"),
				}),
		],
		[
			"applyWrites",
			() =>
				xrpcPost(op(ctx), "com.atproto.space.applyWrites", {
					space,
					repo,
					writes: [create("w", "w")],
				}),
		],
	] as Array<[string, () => Promise<XrpcResult>]>;
}

async function expectNotFound(
	probes: Array<[string, () => Promise<XrpcResult>]>,
	label: string,
): Promise<string[]> {
	const misses: string[] = [];
	for (const [name, call] of probes) {
		const res = await call();
		if (res.error !== "SpaceNotFound")
			misses.push(`${label} ${name} → ${describe(res)}`);
	}
	return misses;
}

const writesSpaceNotFound = defineCheck({
	id: "writes.space-not-found",
	title:
		"The authority's writes to a missing or deleted space answer SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.createRecord@error:SpaceNotFound"),
		L("com.atproto.space.putRecord@error:SpaceNotFound"),
		L("com.atproto.space.applyWrites@error:SpaceNotFound"),
		L("com.atproto.space.deleteSpace"),
		{ source: "changeset", ref: "brave-spaces-exist" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// A write must neither conjure an ungoverned space nor revive a
		// deleted one. (Writes into *another* authority's space are a
		// different matter: a member's host cannot know whether it exists.)
		const deleted = await createProbeSpace(ctx, personalspace());
		await mustCreateRecord(ctx, deleted.uri, "before");
		await deleteProbeSpace(ctx, deleted.uri);
		const misses = [
			...(await expectNotFound(
				writeProbes(ctx, unknownSpaceUri(ctx.target.did)),
				"unknown:",
			)),
			...(await expectNotFound(writeProbes(ctx, deleted.uri), "deleted:")),
		];
		return misses.length
			? fail(`expected SpaceNotFound: ${misses.join("; ")}`)
			: pass(
					"create, put and applyWrites answered SpaceNotFound for a missing and a deleted space",
				);
	},
});

const writesDeleteSpaceNotFound = defineCheck({
	id: "writes.delete-in-missing-space",
	title:
		"The authority's deleteRecord in a missing or deleted space answers SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteRecord@error:SpaceNotFound"),
		L("com.atproto.space.deleteSpace"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// Separate from writes.space-not-found because deleteRecord is also
		// idempotent ("succeeds whether or not the record was present"). That
		// speaks to the record, not the space: deleteRecord declares
		// SpaceNotFound, and deleteSpace says writes to a deleted space fail
		// with it.
		const deleted = await createProbeSpace(ctx, personalspace());
		await mustCreateRecord(ctx, deleted.uri, "w");
		await deleteProbeSpace(ctx, deleted.uri);
		const misses: string[] = [];
		for (const [label, space] of [
			["unknown", unknownSpaceUri(ctx.target.did)],
			["deleted", deleted.uri],
		]) {
			const res = await xrpcPost(op(ctx), "com.atproto.space.deleteRecord", {
				space,
				repo: ctx.target.did,
				collection: POST,
				rkey: "w",
			});
			if (res.error !== "SpaceNotFound")
				misses.push(`${label} → ${describe(res)}`);
		}
		return misses.length
			? fail(`expected SpaceNotFound: ${misses.join("; ")}`)
			: pass("answered SpaceNotFound for a missing and a deleted space");
	},
});

const readsAfterDelete = defineCheck({
	id: "space.reads-after-delete-not-found",
	title: "After deleteSpace, the owner's reads answer SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteSpace"),
		L("com.atproto.space.getRecord@error:SpaceNotFound"),
		L("com.atproto.space.listRecords@error:SpaceNotFound"),
		L("com.atproto.space.getLatestCommit@error:SpaceNotFound"),
		L("com.atproto.space.listRepoOps@error:SpaceNotFound"),
		L("com.atproto.space.getRepo@error:SpaceNotFound"),
		L("com.atproto.space.listBlobs@error:SpaceNotFound"),
		L("com.atproto.space.getBlob@error:SpaceNotFound"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// deleteSpace: "Afterwards, reads and writes fail with SpaceNotFound".
		const space = await createProbeSpace(ctx, personalspace());
		await mustCreateRecord(ctx, space.uri, "before");
		await deleteProbeSpace(ctx, space.uri);
		const base = { space: space.uri, repo: ctx.target.did };
		const cid = await rawCid(crypto.getRandomValues(new Uint8Array(8)));
		const reads: Array<[string, Record<string, string>]> = [
			["getRecord", { ...base, collection: POST, rkey: "before" }],
			["listRecords", base],
			["getLatestCommit", base],
			["listRepoOps", base],
			["getRepo", base],
			["listBlobs", base],
			["getBlob", { ...base, cid }],
		];
		const misses: string[] = [];
		for (const [name, params] of reads) {
			const res = await xrpcGet(op(ctx), `com.atproto.space.${name}`, params);
			if (res.error !== "SpaceNotFound")
				misses.push(`${name} → ${describe(res)}`);
		}
		return misses.length
			? fail(`expected SpaceNotFound: ${misses.join("; ")}`)
			: pass("every read of the deleted space answered SpaceNotFound");
	},
});

const writesPublishedRefused = defineCheck({
	id: "writes.published-collections-refused",
	title: "Direct writes to the policy and member collections are refused",
	tier: "must",
	citations: [
		C("baseline-space-policies"),
		L("com.atproto.space.policy"),
		L("com.atproto.memberspace.member"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// Those records are the PDS's copy of the space's configuration; a
		// forged one would mislead every reader that trusts it.
		const space = await createProbeSpace(ctx, memberspace());
		try {
			const attempts: Array<[string, string, Record<string, unknown>]> = [
				[
					"com.atproto.space.policy",
					"self",
					{
						$type: "com.atproto.space.policy",
						policy: memberspace({ publicRead: true }),
					},
				],
				[
					"com.atproto.memberspace.member",
					"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
					{ $type: "com.atproto.memberspace.member", read: true, write: true },
				],
			];
			const accepted: string[] = [];
			for (const [collection, rkey, record] of attempts) {
				for (const nsid of ["createRecord", "putRecord"]) {
					const res = await xrpcPost(op(ctx), `com.atproto.space.${nsid}`, {
						space: space.uri,
						repo: ctx.target.did,
						collection,
						rkey,
						record,
					});
					if (res.status === 200) accepted.push(`${nsid} ${collection}`);
				}
			}
			return accepted.length
				? fail(`accepted: ${accepted.join(", ")}`)
				: pass("createRecord and putRecord refused both published collections");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

/** sha256 of an all-zero LtHash state: the commit data of an empty repo. */
const emptyRepoData = () => sha256(new Uint8Array(2048));

async function latestCommit(ctx: CheckContext, space: string) {
	const res = await xrpcGet(op(ctx), "com.atproto.space.getLatestCommit", {
		space,
		repo: ctx.target.did,
	});
	const commit = (
		res.json as { commit?: { rev?: string; data?: unknown } } | undefined
	)?.commit;
	return { res, rev: commit?.rev, data: lexBytes(commit?.data) };
}

async function listRecords(
	ctx: CheckContext,
	space: string,
	extra: Record<string, string> = {},
) {
	const res = await xrpcGet(op(ctx), "com.atproto.space.listRecords", {
		space,
		repo: ctx.target.did,
		...extra,
	});
	return {
		res,
		records:
			(res.json as { records?: Array<Record<string, unknown>> } | undefined)
				?.records ?? [],
	};
}

const writesClearRecords = defineCheck({
	id: "writes.clearrecords",
	title:
		"clearRecords empties the repo at a new rev with the empty-repo digest",
	tier: "must",
	citations: [
		L("com.atproto.space.clearRecords"),
		L("com.atproto.space.listRecords"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		const clear = () =>
			xrpcPost(op(ctx), "com.atproto.space.clearRecords", {
				space: space.uri,
				repo: ctx.target.did,
			});
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			await mustCreateRecord(ctx, space.uri, "b");
			const before = await latestCommit(ctx, space.uri);
			const cleared = await clear();
			if (cleared.status !== 200)
				return fail(`clearRecords ${describe(cleared)}`, cleared.json);
			const { records } = await listRecords(ctx, space.uri);
			if (records.length)
				return fail(
					`${records.length} record(s) survived clearRecords`,
					records,
				);
			const after = await latestCommit(ctx, space.uri);
			if (!after.rev || !before.rev || after.rev <= before.rev) {
				return fail(
					`rev did not advance (${before.rev} → ${after.rev})`,
					after.res.json,
				);
			}
			if (!after.data || !bytesEqual(after.data, await emptyRepoData())) {
				return fail(
					"commit data after clearRecords is not the empty repo's digest",
					after.res.json,
				);
			}
			// "Succeeds whether or not the repo held any records to delete."
			const again = await clear();
			return again.status === 200
				? pass(
						"cleared at a new rev with the empty digest; clearing again is a no-op",
					)
				: fail(
						`clearing an empty repo returned ${describe(again)}`,
						again.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const writesClearKeepsPublished = defineCheck({
	id: "writes.clearrecords-keeps-published",
	title:
		"clearRecords in the authority's repo keeps the published policy record",
	tier: "must",
	citations: [L("com.atproto.space.clearRecords")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(
			ctx,
			memberspace({ publishPolicy: true }),
		);
		try {
			await mustCreateRecord(ctx, space.uri, "mine");
			const cleared = await xrpcPost(
				op(ctx),
				"com.atproto.space.clearRecords",
				{
					space: space.uri,
					repo: ctx.target.did,
				},
			);
			if (cleared.status !== 200)
				return fail(`clearRecords ${describe(cleared)}`, cleared.json);
			const own = await operatorGetRecord(ctx, space.uri, "mine");
			if (own.status === 200)
				return fail("the operator's own record survived clearRecords");
			const policy = await operatorGetRecord(
				ctx,
				space.uri,
				"self",
				"com.atproto.space.policy",
			);
			return policy.status === 200
				? pass("own record cleared; the published policy record kept")
				: fail(
						`the published policy record was cleared too (${describe(policy)})`,
						policy.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const syncListRecords = defineCheck({
	id: "sync.listrecords-lists",
	title: "listRecords lists records with values, and excludeValues omits them",
	tier: "must",
	citations: [L("com.atproto.space.listRecords")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const a = await mustCreateRecord(ctx, space.uri, "aaa", "first");
			await mustCreateRecord(ctx, space.uri, "bbb", "second");
			const full = await listRecords(ctx, space.uri, { collection: POST });
			if (full.res.status !== 200)
				return fail(`listRecords ${describe(full.res)}`, full.res.json);
			const entry = full.records.find((r) => r.rkey === "aaa");
			if (full.records.length !== 2 || !entry)
				return fail(`listed ${full.records.length} record(s)`, full.records);
			if (
				entry.collection !== POST ||
				entry.cid !== a.cid ||
				(entry.value as { text?: string })?.text !== "first"
			) {
				return fail("listed entry does not match the written record", entry);
			}
			const bare = await listRecords(ctx, space.uri, {
				collection: POST,
				excludeValues: "true",
			});
			if (bare.records.length !== 2)
				return fail(
					`excludeValues listed ${bare.records.length} record(s)`,
					bare.records,
				);
			return bare.records.some((r) => "value" in r)
				? fail("excludeValues still inlined values", bare.records)
				: pass(
						"listed both records with values; excludeValues listed metadata only",
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const syncListRecordsDescending = defineCheck({
	id: "sync.listrecords-descending-default",
	title: "listRecords defaults to descending record order",
	tier: "should",
	citations: [
		{ source: "reference", ref: "listRecords default order (descending)" },
		L("com.atproto.space.listRecords"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			for (const rkey of ["aaa", "bbb", "ccc"])
				await mustCreateRecord(ctx, space.uri, rkey);
			const { res, records } = await listRecords(ctx, space.uri, {
				collection: POST,
			});
			if (res.status !== 200) return fail(`listRecords ${describe(res)}`);
			const rkeys = records.map((r) => r.rkey);
			return rkeys.join(",") === "ccc,bbb,aaa"
				? pass("records returned descending by default")
				: fail(`order was ${rkeys.join(",")}, reference is descending`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- blobs -------------------------------------------------------------

async function uploadBlob(ctx: CheckContext, bytes: Uint8Array) {
	const upload = await operatorFetch(ctx)(
		`${ctx.target.origin}/xrpc/com.atproto.repo.uploadBlob`,
		{
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: bytes as BodyInit,
		},
	);
	if (upload.status !== 200) throw new Error(`uploadBlob ${upload.status}`);
	return ((await upload.json()) as { blob: { ref: { $link: string } } }).blob;
}

/** Blob isolation: a space blob is never public. */
const blobsSpaceNotPublic = defineCheck({
	id: "blobs.space-blob-not-public",
	title: "A blob is not publicly served unless a public record references it",
	tier: "must",
	citations: [
		L("com.atproto.space.getBlob"),
		{ source: "proposal", ref: "0016#blob-sync" },
	],
	// uploadBlob and sync.getBlob are host-PDS endpoints, not space methods.
	needs: ["operator", "pds-blobs"],
	destructive: true,
	async run(ctx) {
		// A blob must never be publicly addressable until a *public* record
		// references it. Probe both slices: freshly uploaded (unreferenced),
		// then referenced only from a space.
		const space = await createProbeSpace(ctx);
		try {
			const blob = await uploadBlob(
				ctx,
				crypto.getRandomValues(new Uint8Array(16)),
			);
			const publicUrl = `${ctx.target.origin}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ctx.target.did)}&cid=${blob.ref.$link}`;
			const stagedGet = await ctx.fetch(publicUrl);
			if (stagedGet.status === 200) {
				return fail(
					"an uploaded, unreferenced blob was served by the public sync.getBlob",
				);
			}
			const write = await operatorCreateRecord(
				ctx,
				space.uri,
				"earth.cirrus.check.withblob",
				"self",
				{
					$type: "earth.cirrus.check.withblob",
					file: blob,
				},
			);
			if (write.status !== 200)
				return fail(`referencing write ${describe(write)}`, write.json);
			const publicGet = await ctx.fetch(publicUrl);
			return publicGet.status === 200
				? fail("a space blob was served by the public sync.getBlob")
				: pass(
						`public sync.getBlob refused the blob unreferenced (${stagedGet.status}) and space-referenced (${publicGet.status})`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const blobsListAndGet = defineCheck({
	id: "blobs.listblobs-and-getblob",
	title: "listBlobs lists a space record's blob and space.getBlob serves it",
	tier: "must",
	citations: [L("com.atproto.space.listBlobs"), L("com.atproto.space.getBlob")],
	needs: ["operator", "pds-blobs"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			const bytes = crypto.getRandomValues(new Uint8Array(24));
			const blob = await uploadBlob(ctx, bytes);
			const write = await operatorCreateRecord(
				ctx,
				space.uri,
				"earth.cirrus.check.withblob",
				"self",
				{
					$type: "earth.cirrus.check.withblob",
					file: blob,
				},
			);
			if (write.status !== 200)
				return fail(`referencing write ${describe(write)}`, write.json);
			const list = await xrpcGet(op(ctx), "com.atproto.space.listBlobs", {
				space: space.uri,
				repo: ctx.target.did,
			});
			const cids = (list.json as { cids?: string[] } | undefined)?.cids ?? [];
			if (!cids.includes(blob.ref.$link))
				return fail(
					`listBlobs ${describe(list)} did not list the blob`,
					list.json,
				);
			const res = await operatorFetch(ctx)(
				`${ctx.target.origin}/xrpc/com.atproto.space.getBlob?space=${encodeURIComponent(space.uri)}&repo=${encodeURIComponent(ctx.target.did)}&cid=${blob.ref.$link}`,
			);
			if (res.status !== 200) return fail(`space.getBlob ${res.status}`);
			const served = new Uint8Array(await res.arrayBuffer());
			return bytesEqual(served, bytes)
				? pass("listed and served the exact bytes")
				: fail("space.getBlob served different bytes");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const blobsNotFound = defineCheck({
	id: "blobs.getblob-not-found",
	title:
		"space.getBlob of a blob the space does not reference answers BlobNotFound",
	tier: "must",
	citations: [L("com.atproto.space.getBlob@error:BlobNotFound")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await mustCreateRecord(ctx, space.uri, "present");
			const res = await xrpcGet(op(ctx), "com.atproto.space.getBlob", {
				space: space.uri,
				repo: ctx.target.did,
				cid: await rawCid(crypto.getRandomValues(new Uint8Array(16))),
			});
			return res.error === "BlobNotFound"
				? pass("answered BlobNotFound")
				: fail(`answered ${describe(res)}, expected BlobNotFound`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

export const recordChecks: Check[] = [
	writesCreateRead,
	writesUnauthReadRefused,
	writesDuplicate,
	writesPutRecord,
	writesGetRecordMissing,
	writesDeleteIdempotent,
	writesApplyWritesAtomic,
	writesApplyWritesMissing,
	writesSpaceNotFound,
	writesDeleteSpaceNotFound,
	readsAfterDelete,
	writesPublishedRefused,
	writesClearRecords,
	writesClearKeepsPublished,
	syncListRecords,
	syncListRecordsDescending,
	blobsSpaceNotPublic,
	blobsListAndGet,
	blobsNotFound,
];
