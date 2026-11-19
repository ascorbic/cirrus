/**
 * The crypto-bound check catalog: the checks that genuinely need the
 * alpha libs or harness-held foreign identities, and nothing else — every
 * check an operator session can run with plain fetch + WebCrypto lives in
 * `../checks/` instead, browser included.
 *
 * What keeps a check here:
 * - verifying what a target serves — commit and record MACs, STAR
 *   archives, token signatures — with the reference library;
 * - building archives (space meta, repo STARs) to import;
 * - `identities`: the harness plays a reader, a writer's PDS or a foreign
 *   space authority, minting tokens the target must verify by resolving
 *   that party's DID.
 *
 * Each check's metadata comes from `../descriptors.ts`, the dependency-free
 * list the browser catalog shows as "not testable here".
 */

import {
	RepoCommit,
	readRepoStar,
	readSpaceMetaStar,
	spaceHostAud,
	verifyCommit,
	verifyRecord,
	verifyRepoStarFull,
	verifySpaceToken,
	writeRepoStar,
	writeSpaceMetaStar,
	type SpaceMetaArchive,
} from "@atproto/space";
import { parseCid } from "@atproto/lex-data";
import { defineCheck } from "../registry.js";
import { descriptor } from "../descriptors.js";
import {
	asOperator,
	operatorFetch,
	xrpcGet,
	xrpcPost,
	xrpcPostBytes,
} from "../http.js";
import {
	fail,
	pass,
	type Check,
	type CheckContext,
	type CheckOutcome,
} from "../model.js";
import {
	bytesEqual,
	decodeJwt,
	isTid,
	lexBytes,
	tidAt,
	tidNow,
	toBase64,
	utf8,
} from "../encoding.js";
import { resolveDidDocument, verificationMethodDidKey } from "../did.js";
import {
	COMMIT_MAC_PROFILE,
	createCredentialKey,
	formatMacRequest,
} from "../space-auth.js";
import {
	FOREIGN_DID,
	POST,
	PROBE_TYPE,
	createProbeSpace,
	credentialCall,
	credentialGet,
	deleteProbeSpace,
	describe,
	managedspace,
	memberspace,
	mustCreateRecord,
	obtainPublicCredential,
	operatorCreateRecord,
	personalspace,
	probeSkey,
	publicRead,
	unknownSpaceUri,
	type Credential,
} from "../checks/probe.js";
import { fakeDid, putMembers } from "../checks/space.js";
import { ACCOUNT_REFUSALS } from "../checks/credential.js";
import { listWriters } from "../checks/host.js";
import {
	collectBytes,
	commitFromJson,
	macParams,
	mintCredential,
	mintDelegation,
	obtainCredential,
	serviceJwt,
} from "./helpers.js";

type Did = `did:${string}:${string}`;

const crypto$ = (
	id: string,
	run: (ctx: CheckContext) => Promise<CheckOutcome>,
): Check => defineCheck({ ...descriptor(id), run });

const errMsg = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/** A public-read space with two records and a credential for it. */
async function withPublicSpace<T>(
	ctx: CheckContext,
	fn: (space: string, credential: Credential) => Promise<T>,
): Promise<T> {
	const space = await createProbeSpace(ctx, publicRead());
	try {
		await mustCreateRecord(ctx, space.uri, "a", "one");
		await mustCreateRecord(ctx, space.uri, "b", "two");
		return await fn(space.uri, await obtainPublicCredential(ctx, space.uri));
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
}

// --- MAC verification ---------------------------------------------------

const macCommit = crypto$("mac.commit-verifies", (ctx) =>
	withPublicSpace(ctx, async (space, credential) => {
		// A custom label, and a request for some other profile alongside: the
		// host must answer under the label asked for and ignore the stranger.
		const res = await credentialCall(
			ctx,
			credential,
			"com.atproto.space.getLatestCommit",
			{
				params: { space, repo: ctx.target.did },
				mac: {
					profile: COMMIT_MAC_PROFILE,
					header: (k) =>
						`${formatMacRequest(COMMIT_MAC_PROFILE, k, { label: "m1" })}, other=("content-digest");tag="someone-elses"`,
				},
			},
		);
		if (res.status !== 200)
			return fail(`getLatestCommit ${describe(res)}`, res.json);
		const raw = (res.json as { commit?: Record<string, unknown> }).commit ?? {};
		const keys = Object.keys(raw).sort().join(",");
		if (keys !== "data,repo,rev,space,ver")
			return fail(
				`commit carries {${keys}}, expected exactly {data,repo,rev,space,ver}`,
				raw,
			);
		const commit = commitFromJson(raw);
		if (
			!commit ||
			commit.ver !== 1 ||
			!isTid(commit.rev) ||
			commit.data.length !== 32
		) {
			return fail(
				"commit fields malformed (ver 1, TID rev, 32-byte data)",
				raw,
			);
		}
		const input = res.headers.get("signature-input") ?? "";
		if (!/^m1=/.test(input))
			return fail(`MAC not under the requested label: ${input}`);
		const vary = (res.headers.get("vary") ?? "").toLowerCase();
		if (
			!vary
				.split(",")
				.map((v) => v.trim())
				.includes("accept-signature")
		)
			return fail(`Vary does not list Accept-Signature: ${vary}`);
		try {
			verifyCommit(commit, {
				space: space as never,
				repo: ctx.target.did as Did,
				...macParams(res),
			});
			return pass(
				"commit shape as specified; MAC verifies under the requested label; Vary lists Accept-Signature",
			);
		} catch (err) {
			return fail(`verifyCommit rejected the response: ${errMsg(err)}`, raw);
		}
	}),
);

const macRecord = crypto$("mac.record-verifies", (ctx) =>
	withPublicSpace(ctx, async (space, credential) => {
		const res = await credentialGet(
			ctx,
			credential,
			"com.atproto.space.getRecord",
			{
				space,
				repo: ctx.target.did,
				collection: POST,
				rkey: "a",
			},
		);
		if (res.status !== 200) return fail(`getRecord ${describe(res)}`, res.json);
		const record = res.json as {
			uri: string;
			cid: string;
			value: Record<string, unknown>;
		};
		try {
			await verifyRecord(record as never, {
				uri: record.uri as never,
				...macParams(res),
			});
			return pass("record MAC verifies over uri and cid; value encodes to cid");
		} catch (err) {
			return fail(`verifyRecord rejected the response: ${errMsg(err)}`, record);
		}
	}),
);

const oplogFolds = crypto$("sync.oplog-folds-to-commit", (ctx) =>
	withPublicSpace(ctx, async (space, credential) => {
		// One more op that replaces a record, so the fold exercises `prev`.
		await xrpcPost(asOperator(ctx), "com.atproto.space.putRecord", {
			space,
			repo: ctx.target.did,
			collection: POST,
			rkey: "a",
			record: { $type: POST, text: "one, again" },
		});
		// One op per page: every page, not just the last, carries the commit.
		const folded = new RepoCommit();
		let cursor: string | undefined;
		let pages = 0;
		let last: ReturnType<typeof commitFromJson>;
		for (; pages < 20; pages++) {
			const res = await credentialGet(
				ctx,
				credential,
				"com.atproto.space.listRepoOps",
				{
					space,
					repo: ctx.target.did,
					limit: "1",
					cursor,
				},
			);
			if (res.status !== 200)
				return fail(
					`listRepoOps page ${pages + 1}: ${describe(res)}`,
					res.json,
				);
			const body = res.json as {
				ops: Array<{
					collection: string;
					rkey: string;
					cid: string | null;
					prev: string | null;
				}>;
				commit?: unknown;
				cursor?: string;
			};
			last = commitFromJson(body.commit);
			if (!last) return fail(`page ${pages + 1} carried no commit`, body);
			try {
				verifyCommit(last, {
					space: space as never,
					repo: ctx.target.did as Did,
					...macParams(res),
				});
			} catch (err) {
				return fail(
					`page ${pages + 1}'s commit MAC does not verify: ${errMsg(err)}`,
				);
			}
			folded.applyOps(
				body.ops.map((op) => ({
					collection: op.collection,
					rkey: op.rkey,
					cid: op.cid ? parseCid(op.cid) : null,
					prev: op.prev ? parseCid(op.prev) : null,
				})) as never,
			);
			cursor = body.cursor;
			if (!cursor) break;
		}
		if (pages < 2) return fail("three ops at limit=1 did not paginate");
		return folded.matches(last!)
			? pass(
					`${pages + 1} pages, each with a MAC-verified commit; the ops fold to its data`,
				)
			: fail("the folded oplog does not match the commit data");
	}),
);

const getRepoStar = crypto$("sync.getrepo-star", (ctx) =>
	withPublicSpace(ctx, async (space, credential) => {
		const res = await credentialGet(
			ctx,
			credential,
			"com.atproto.space.getRepo",
			{ space, repo: ctx.target.did },
		);
		if (res.status !== 200) return fail(`getRepo ${describe(res)}`, res.json);
		const type = res.headers.get("Content-Type") ?? "";
		if (!type.includes("application/vnd.dasl.star"))
			return fail(`getRepo content-type was ${type}`);
		const bytes = new Uint8Array(await res.response.arrayBuffer());
		try {
			const { records } = await verifyRepoStarFull([bytes], {
				space: space as never,
				repo: ctx.target.did as Did,
				...macParams(res),
			});
			const rkeys = records.map((r) => `${r.collection}/${r.rkey}`).sort();
			return rkeys.join(",") === `${POST}/a,${POST}/b`
				? pass("STAR archive verified against its MAC; both records present")
				: fail(`archive verified but held ${rkeys.join(", ") || "no records"}`);
		} catch (err) {
			return fail(`verifyRepoStarFull rejected the archive: ${errMsg(err)}`);
		}
	}),
);

// --- token signatures -------------------------------------------------

async function atprotoKey(ctx: CheckContext, did: string): Promise<string> {
	const key = verificationMethodDidKey(
		await resolveDidDocument(ctx, did),
		"atproto",
	);
	if (!key) throw new Error(`${did} publishes no #atproto key`);
	return key;
}

const credentialSigned = crypto$(
	"credential.signed-by-authority",
	async (ctx) => {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			try {
				await verifySpaceToken("credential", credential.credential, {
					getSigningKey: (iss) => atprotoKey(ctx, iss),
					sub: space.uri,
				});
				return pass("verifies against the authority's #atproto key");
			} catch (err) {
				return fail(`credential did not verify: ${errMsg(err)}`);
			}
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

const delegationSigned = crypto$("delegation.signed-by-user", async (ctx) => {
	const space = await createProbeSpace(ctx, memberspace());
	try {
		const res = await xrpcGet(
			asOperator(ctx),
			"com.atproto.space.getDelegationToken",
			{ space: space.uri },
		);
		if (res.status !== 200)
			return fail(`getDelegationToken ${describe(res)}`, res.json);
		try {
			await verifySpaceToken(
				"delegation",
				(res.json as { token: string }).token,
				{
					getSigningKey: (iss) => atprotoKey(ctx, iss),
					aud: spaceHostAud(ctx.target.did as Did),
					sub: space.uri,
				},
			);
			return pass("verifies against the user's #atproto key");
		} catch (err) {
			return fail(`delegation token did not verify: ${errMsg(err)}`);
		}
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

// --- migration ----------------------------------------------------------

async function exportMeta(ctx: CheckContext, space: string) {
	const res = await operatorFetch(ctx)(
		`${ctx.target.origin}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(space)}`,
	);
	if (res.status !== 200)
		throw new Error(
			`exportSpaceMeta ${res.status} ${await res.text().catch(() => "")}`,
		);
	return {
		type: res.headers.get("Content-Type") ?? "",
		archive: await readSpaceMetaStar([new Uint8Array(await res.arrayBuffer())]),
	};
}

const importMeta = async (ctx: CheckContext, archive: SpaceMetaArchive) =>
	xrpcPostBytes(
		asOperator(ctx),
		"com.atproto.space.importSpaceMeta",
		await collectBytes(writeSpaceMetaStar(archive)),
	);

const memberKey = (did: string) => `com.atproto.memberspace.member/${did}`;

const exportSpaceMeta = crypto$("migration.export-space-meta", async (ctx) => {
	const space = await createProbeSpace(ctx, memberspace({ publicWrite: true }));
	const member = fakeDid();
	try {
		await putMembers(ctx, space.uri, [
			{ did: member, read: true, write: false },
		]);
		await mustCreateRecord(ctx, space.uri, "a");
		const { type, archive } = await exportMeta(ctx, space.uri);
		const problems: string[] = [];
		if (!type.includes("application/vnd.dasl.star"))
			problems.push(`content-type ${type}`);
		if (archive.space !== space.uri) problems.push(`space ${archive.space}`);
		if (archive.policy.$type !== "com.atproto.memberspace.policy")
			problems.push(`policy ${String(archive.policy.$type)}`);
		const entry = archive.policyState.find((e) => e.key === memberKey(member));
		if (!entry || entry.value.read !== true || entry.value.write !== false)
			problems.push("member entry missing or wrong");
		const writer = archive.writers.find((w) => w.did === ctx.target.did);
		if (!writer || !isTid(writer.repoRev))
			problems.push("the authority is not in the writer set with a repoRev");
		if (problems.length) return fail(problems.join("; "), archive);
		// A removed writer is left out of the archive.
		await xrpcPost(asOperator(ctx), "com.atproto.space.removeWriter", {
			space: space.uri,
			repo: ctx.target.did,
		});
		const after = await exportMeta(ctx, space.uri);
		return after.archive.writers.some((w) => w.did === ctx.target.did)
			? fail("a removed writer is still in the exported writer set")
			: pass(
					"archive carries the policy, the member and live writers with repoRev; removed writers are left out",
				);
	} catch (err) {
		return fail(errMsg(err));
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const importSpaceMeta = crypto$("migration.import-space-meta", async (ctx) => {
	const space = await createProbeSpace(ctx, memberspace());
	const before = fakeDid();
	const after = fakeDid();
	try {
		await putMembers(ctx, space.uri, [
			{ did: before, read: true, write: true },
		]);
		const { archive } = await exportMeta(ctx, space.uri);
		// Import a changed configuration over the space: it replaces, not merges.
		const imported = await importMeta(ctx, {
			...archive,
			policy: { $type: "com.atproto.memberspace.policy", publicRead: true },
			policyState: [
				{
					key: memberKey(after),
					value: {
						$type: "com.atproto.memberspace.member",
						read: true,
						write: false,
					},
				},
			],
		});
		if (imported.status !== 200)
			return fail(`importSpaceMeta ${describe(imported)}`, imported.json);
		const got = await xrpcGet(asOperator(ctx), "com.atproto.space.getSpace", {
			space: space.uri,
		});
		const policy = (
			got.json as { policy?: { publicRead?: boolean } } | undefined
		)?.policy;
		const list = await xrpcGet(
			asOperator(ctx),
			"com.atproto.memberspace.listMembers",
			{ space: space.uri },
		);
		const dids = (
			(list.json as { members?: Array<{ did: string }> } | undefined)
				?.members ?? []
		).map((m) => m.did);
		if (policy?.publicRead !== true)
			return fail("getSpace does not reflect the imported policy", got.json);
		return dids.includes(after) && !dids.includes(before)
			? pass("imported policy and member list replaced the old ones")
			: fail(`members after import: ${dids.join(", ") || "none"}`, list.json);
	} catch (err) {
		return fail(errMsg(err));
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const importMetaNotAuthority = crypto$(
	"migration.import-space-meta-not-authority",
	async (ctx) => {
		const res = await importMeta(ctx, {
			space: unknownSpaceUri(FOREIGN_DID) as never,
			policy: { $type: "com.atproto.personalspace.policy" },
			policyState: [],
			writers: [],
		});
		return res.error === "NotAuthorized"
			? pass("answered NotAuthorized")
			: fail(`answered ${describe(res)}, expected NotAuthorized`, res.json);
	},
);

const importMetaUnsupported = crypto$(
	"migration.import-space-meta-unsupported-policy",
	async (ctx) => {
		const space = unknownSpaceUri(ctx.target.did);
		const res = await importMeta(ctx, {
			space: space as never,
			policy: { $type: "com.example.mysteryPolicy" },
			policyState: [],
			writers: [],
		});
		if (res.status === 200) await deleteProbeSpace(ctx, space);
		return res.error === "UnsupportedPolicy"
			? pass("answered UnsupportedPolicy")
			: fail(`answered ${describe(res)}, expected UnsupportedPolicy`, res.json);
	},
);

const importMetaInvalid = crypto$(
	"migration.import-space-meta-invalid",
	async (ctx) => {
		const res = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importSpaceMeta",
			utf8("not a STAR archive"),
		);
		return res.error === "InvalidSpaceMeta"
			? pass("answered InvalidSpaceMeta")
			: fail(`answered ${describe(res)}, expected InvalidSpaceMeta`, res.json);
	},
);

async function ownRepoArchive(
	ctx: CheckContext,
	space: string,
): Promise<Uint8Array> {
	const res = await operatorFetch(ctx)(
		`${ctx.target.origin}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(ctx.target.did)}`,
	);
	if (res.status !== 200) throw new Error(`getRepo ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

const importRepo = crypto$("migration.import-repo", async (ctx) => {
	const space = await createProbeSpace(ctx, personalspace());
	try {
		await mustCreateRecord(ctx, space.uri, "a", "one");
		await mustCreateRecord(ctx, space.uri, "b", "two");
		const bytes = await ownRepoArchive(ctx, space.uri);
		const exported = await readRepoStar([bytes]);
		const commit = exported.commit;
		await exported[Symbol.asyncDispose]();
		// Change the repo after export, so the import visibly replaces it.
		await mustCreateRecord(ctx, space.uri, "c", "three");
		// The lexicon's input encoding is application/vnd.dasl.star.
		const wrongType = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importRepo",
			bytes,
			undefined,
			"application/octet-stream",
		);
		if (wrongType.status === 200)
			return fail("importRepo accepted an application/octet-stream body");
		const res = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importRepo",
			bytes,
		);
		if (res.status !== 200)
			return fail(`importRepo ${describe(res)}`, res.json);
		const list = await xrpcGet(
			asOperator(ctx),
			"com.atproto.space.listRecords",
			{ space: space.uri, repo: ctx.target.did },
		);
		const rkeys = (
			(list.json as { records?: Array<{ rkey: string }> } | undefined)
				?.records ?? []
		)
			.map((r) => r.rkey)
			.sort();
		if (rkeys.join(",") !== "a,b")
			return fail(`records after import: ${rkeys.join(",")}`, list.json);
		const latest = await xrpcGet(
			asOperator(ctx),
			"com.atproto.space.getLatestCommit",
			{ space: space.uri, repo: ctx.target.did },
		);
		const now = commitFromJson(
			(latest.json as { commit?: unknown } | undefined)?.commit,
		);
		if (!now)
			return fail(
				`getLatestCommit after import ${describe(latest)}`,
				latest.json,
			);
		if (!bytesEqual(now.data, commit.data))
			return fail("commit data changed across the import");
		return now.rev > commit.rev
			? pass(
					"refused octet-stream; records replaced from the archive; same data, new rev",
				)
			: fail(`rev ${now.rev} did not advance past the archive's ${commit.rev}`);
	} catch (err) {
		return fail(errMsg(err));
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const emptyRepoArchive = (space: string, repo: string) =>
	collectBytes(
		writeRepoStar(
			new RepoCommit().toCommit({
				space: space as never,
				repo: repo as Did,
				rev: tidNow() as never,
			}),
			[],
		),
	);

const importRepoNotFound = crypto$(
	"migration.import-repo-space-not-found",
	async (ctx) => {
		// A well-formed archive of an empty repo in an own space this host has
		// never heard of: the authority's space must be imported first.
		const space = `at://${ctx.target.did}/space/${PROBE_TYPE}/${probeSkey()}`;
		const res = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importRepo",
			await emptyRepoArchive(space, ctx.target.did),
		);
		if (res.status === 200) await deleteProbeSpace(ctx, space);
		return res.error === "SpaceNotFound"
			? pass("answered SpaceNotFound")
			: fail(`answered ${describe(res)}, expected SpaceNotFound`, res.json);
	},
);

const importRepoInvalid = crypto$(
	"migration.import-repo-invalid",
	async (ctx) => {
		const res = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importRepo",
			utf8("not a STAR archive"),
		);
		return res.error === "InvalidRepoFile"
			? pass("answered InvalidRepoFile")
			: fail(`answered ${describe(res)}, expected InvalidRepoFile`, res.json);
	},
);

const importRepoMismatch = crypto$(
	"migration.import-repo-mismatch",
	async (ctx) => {
		const space = await createProbeSpace(ctx, personalspace());
		try {
			const res = await xrpcPostBytes(
				asOperator(ctx),
				"com.atproto.space.importRepo",
				await emptyRepoArchive(space.uri, fakeDid()),
			);
			return res.error === "RepoMismatch"
				? pass("answered RepoMismatch")
				: fail(`answered ${describe(res)}, expected RepoMismatch`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

// --- foreign identities --------------------------------------------------

const isAccountRefusal = (error?: string) =>
	error !== undefined && ACCOUNT_REFUSALS.includes(error);

const memberGate = crypto$("credential.member-gate", async (ctx) => {
	const reader = await ctx.identities!.identity("reader");
	const space = await createProbeSpace(ctx, memberspace());
	const put = (read: boolean) =>
		putMembers(ctx, space.uri, [{ did: reader.did, read, write: false }]);
	try {
		await mustCreateRecord(ctx, space.uri, "shared", "members only");
		const stranger = await obtainCredential(ctx, reader, space.uri);
		if (stranger.credential) return fail("a non-member obtained a credential");
		if (!isAccountRefusal(stranger.result.error)) {
			return fail(
				`non-member refused with ${describe(stranger.result)}; expected ${ACCOUNT_REFUSALS.join(" / ")}`,
			);
		}
		await put(false);
		const writeOnly = await obtainCredential(ctx, reader, space.uri);
		if (writeOnly.credential)
			return fail("a member with read: false obtained a credential");
		await put(true);
		const member = await obtainCredential(ctx, reader, space.uri);
		if (!member.credential)
			return fail(
				`a reader was refused: ${describe(member.result)}`,
				member.result.json,
			);
		const read = await credentialGet(
			ctx,
			member.credential,
			"com.atproto.space.getRecord",
			{
				space: space.uri,
				repo: ctx.target.did,
				collection: POST,
				rkey: "shared",
			},
		);
		return read.status === 200
			? pass(
					`non-member refused (${stranger.result.error}), read:false refused, reader admitted and read`,
				)
			: fail(
					`the reader's credential could not read: ${describe(read)}`,
					read.json,
				);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const personalOnly = crypto$("policy.personalspace-owner-only", async (ctx) => {
	const reader = await ctx.identities!.identity("reader");
	const space = await createProbeSpace(ctx, personalspace());
	try {
		const res = await obtainCredential(ctx, reader, space.uri);
		if (res.credential)
			return fail("a personalspace issued a credential to another account");
		return isAccountRefusal(res.result.error)
			? pass(`refused with ${res.result.error}`)
			: fail(
					`refused with ${describe(res.result)}; expected ${ACCOUNT_REFUSALS.join(" / ")}`,
				);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const delegationWrongAud = crypto$(
	"delegation.wrong-audience-refused",
	async (ctx) => {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx, memberspace());
		try {
			await putMembers(ctx, space.uri, [
				{ did: reader.did, read: true, write: false },
			]);
			// Positive control: with the right audience the reader is admitted.
			const control = await obtainCredential(ctx, reader, space.uri);
			if (!control.credential)
				return fail(
					`correct-aud control failed (${describe(control.result)}); cannot attribute the wrong-aud refusal`,
				);
			const { result, credential } = await obtainCredential(
				ctx,
				reader,
				space.uri,
				{ audOverride: `${FOREIGN_DID}#atproto_pds` },
			);
			if (credential)
				return fail("a token addressed to another host was accepted");
			return result.error === "InvalidDelegationToken"
				? pass("refused with InvalidDelegationToken")
				: fail(
						`refused with ${describe(result)}, expected InvalidDelegationToken`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

async function notifyRepoUpdate(
	ctx: CheckContext,
	writer: {
		did: string;
		jwtAlg: string;
		sign(b: Uint8Array): Promise<Uint8Array>;
	},
	space: string,
	repoRev: string,
	data: Uint8Array,
) {
	const jwt = await serviceJwt(writer, {
		aud: spaceHostAud(ctx.target.did as Did),
		lxm: "com.atproto.space.notifyRepoUpdate",
	});
	return xrpcPost(
		ctx,
		"com.atproto.space.notifyRepoUpdate",
		{
			space,
			repo: writer.did,
			repoRev,
			data: { $bytes: toBase64(data).replace(/=+$/, "") },
		},
		{ Authorization: `Bearer ${jwt}` },
	);
}

const notifyAccepted = crypto$(
	"host.notifyrepoupdate-accepted",
	async (ctx) => {
		const writer = await ctx.identities!.identity("writer");
		const space = await createProbeSpace(
			ctx,
			memberspace({ publicRead: true }),
		);
		try {
			await putMembers(ctx, space.uri, [
				{ did: writer.did, read: false, write: true },
			]);
			const repoRev = tidNow();
			const data = globalThis.crypto.getRandomValues(new Uint8Array(32));
			const res = await notifyRepoUpdate(ctx, writer, space.uri, repoRev, data);
			if (res.status !== 200)
				return fail(`notifyRepoUpdate ${describe(res)}`, res.json);
			const { repos } = await listWriters(
				ctx,
				await obtainPublicCredential(ctx, space.uri),
			);
			const entry = repos.find((r) => r.repo === writer.did);
			if (!entry) return fail("the notified writer is not in listWriters");
			const listed = lexBytes(entry.data);
			return entry.$type === "com.atproto.space.defs#repoWrite" &&
				entry.repoRev === repoRev &&
				listed &&
				bytesEqual(listed, data)
				? pass("accepted; listWriters reports the notified repoRev and data")
				: fail("listWriters entry does not match the notification", entry);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

const notifyFuture = crypto$(
	"host.notifyrepoupdate-future-rev",
	async (ctx) => {
		const writer = await ctx.identities!.identity("writer");
		const space = await createProbeSpace(
			ctx,
			memberspace({ publicWrite: true }),
		);
		try {
			const hourAhead = BigInt(Date.now() + 60 * 60 * 1000) * 1000n;
			const res = await notifyRepoUpdate(
				ctx,
				writer,
				space.uri,
				tidAt(hourAhead),
				new Uint8Array(32),
			);
			return res.error === "FutureRev"
				? pass("a repoRev an hour ahead answered FutureRev")
				: fail(`answered ${describe(res)}, expected FutureRev`, res.json);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

const notifyUnknown = crypto$(
	"host.notifyrepoupdate-unknown-space",
	async (ctx) => {
		const writer = await ctx.identities!.identity("writer");
		const res = await notifyRepoUpdate(
			ctx,
			writer,
			unknownSpaceUri(ctx.target.did),
			tidNow(),
			new Uint8Array(32),
		);
		return res.error === "SpaceNotFound"
			? pass("answered SpaceNotFound")
			: fail(`answered ${describe(res)}, expected SpaceNotFound`, res.json);
	},
);

const writeRevocation = crypto$(
	"memberspace.write-revocation-removes-writer",
	async (ctx) => {
		const writer = await ctx.identities!.identity("writer");
		const space = await createProbeSpace(
			ctx,
			memberspace({ publicRead: true, publicWrite: true }),
		);
		try {
			await putMembers(ctx, space.uri, [
				{ did: writer.did, read: true, write: true },
			]);
			const first = await notifyRepoUpdate(
				ctx,
				writer,
				space.uri,
				tidNow(),
				new Uint8Array(32),
			);
			if (first.status !== 200)
				return fail(`notifyRepoUpdate ${describe(first)}`, first.json);
			const credential = await obtainPublicCredential(ctx, space.uri);
			const entry = async () =>
				(await listWriters(ctx, credential)).repos
					.filter((r) => r.repo === writer.did)
					.at(-1);
			if ((await entry())?.$type !== "com.atproto.space.defs#repoWrite")
				return fail("the writer never entered the writer set");
			// Revoking write access removes it, announced as repoRemoved...
			await putMembers(ctx, space.uri, [
				{ did: writer.did, read: true, write: false },
			]);
			const removed = await entry();
			if (removed?.$type !== "com.atproto.space.defs#repoRemoved")
				return fail(
					`after revoking write, the entry is ${JSON.stringify(removed)}`,
				);
			// ...and, even under publicWrite, a member without write is not tracked.
			const again = await notifyRepoUpdate(
				ctx,
				writer,
				space.uri,
				tidNow(),
				new Uint8Array(32),
			);
			const after = await entry();
			return after?.$type === "com.atproto.space.defs#repoRemoved"
				? pass(
						`removed as repoRemoved; a later notification was not tracked (${describe(again)})`,
					)
				: fail(
						"a member without write access was tracked again under publicWrite",
						after,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

/**
 * The revocation flow: a harness identity plays a foreign space authority,
 * the operator writes into that space (as a member's PDS would), and the
 * authority's credential reads the operator's repo — until revoked.
 */
async function revocationFlow(
	ctx: CheckContext,
	revoker: "authority" | "stranger",
): Promise<{
	detail?: string;
	revoke?: { status: number; error?: string };
	after?: { status: number; error?: string };
}> {
	const authority = await ctx.identities!.identity("authority");
	const space = `at://${authority.did}/space/${PROBE_TYPE}/${probeSkey()}`;
	const write = await operatorCreateRecord(ctx, space, POST, "shared", {
		$type: POST,
		text: "for the authority",
	});
	if (write.status !== 200)
		return {
			detail: `operator write into a foreign space: ${describe(write)}`,
		};
	const key = await createCredentialKey();
	const credential: Credential = {
		credential: await mintCredential(authority, space, key.did),
		key,
		space,
	};
	const read = () =>
		credentialGet(ctx, credential, "com.atproto.space.getRecord", {
			space,
			repo: ctx.target.did,
			collection: POST,
			rkey: "shared",
		});
	const before = await read();
	if (before.status !== 200)
		return {
			detail: `foreign authority's credential could not read: ${describe(before)}`,
		};
	const signer =
		revoker === "authority"
			? authority
			: await ctx.identities!.identity("stranger");
	const jwt = await serviceJwt(signer, {
		aud: ctx.target.did,
		lxm: "com.atproto.space.notifyCredentialsRevoked",
	});
	const revoke = await xrpcPost(
		ctx,
		"com.atproto.space.notifyCredentialsRevoked",
		{ space, credentials: [decodeJwt(credential.credential).payload.jti] },
		{ Authorization: `Bearer ${jwt}` },
	);
	return { revoke, after: await read() };
}

const revocationRefused = crypto$(
	"revocation.revoked-credential-refused",
	async (ctx) => {
		const flow = await revocationFlow(ctx, "authority");
		if (flow.detail) return fail(flow.detail);
		if (flow.revoke!.status !== 200)
			return fail(
				`notifyCredentialsRevoked ${flow.revoke!.status} ${flow.revoke!.error ?? ""}`,
			);
		return flow.after!.status >= 400 && flow.after!.status < 500
			? pass(
					`foreign credential read 200; after revocation refused (${flow.after!.status} ${flow.after!.error ?? ""})`,
				)
			: fail(`a revoked credential still read (${flow.after!.status})`);
	},
);

const revocationName = crypto$("revocation.error-name", async (ctx) => {
	const flow = await revocationFlow(ctx, "authority");
	if (flow.detail) return fail(flow.detail);
	return flow.after!.error === "CredentialRevoked"
		? pass("refused with CredentialRevoked")
		: fail(`refused with ${flow.after!.status} ${flow.after!.error ?? ""}`);
});

const revocationStranger = crypto$(
	"revocation.non-authority-refused",
	async (ctx) => {
		const flow = await revocationFlow(ctx, "stranger");
		if (flow.detail) return fail(flow.detail);
		if (flow.revoke!.status === 200)
			return fail(
				"accepted a revocation signed by someone other than the authority",
			);
		return flow.after!.status === 200
			? pass(
					`stranger's revocation refused (${flow.revoke!.status} ${flow.revoke!.error ?? ""}); credential still reads`,
				)
			: fail(
					`the revocation was refused but the credential stopped working (${flow.after!.status})`,
				);
	},
);

const managedAccount = crypto$(
	"managedspace.check-access-account",
	async (ctx) => {
		const inbox = ctx.syncerInbox!;
		const reader = await ctx.identities!.identity("reader");
		const lxm = "com.atproto.managedspace.checkAccess";
		let answer = { read: false, write: false };
		inbox.respond(lxm, () => answer);
		const space = await createProbeSpace(ctx, managedspace(inbox.service));
		try {
			const since = Date.now();
			const denied = await obtainCredential(ctx, reader, space.uri);
			if (denied.credential)
				return fail("issued a credential the managing app refused");
			const asked = await inbox.waitFor(
				(d) =>
					d.lxm === lxm &&
					d.receivedAt >= since &&
					d.params?.repo === reader.did,
				5_000,
			);
			if (!asked)
				return fail(
					`the managing app was never asked about the reader (${describe(denied.result)})`,
				);
			const p = asked.params ?? {};
			if (p.space !== space.uri || "access" in p)
				return fail("checkAccess carried the wrong params", p);
			answer = { read: true, write: false };
			const allowed = await obtainCredential(ctx, reader, space.uri);
			return allowed.credential
				? pass(
						`asked about the reader (space, repo); refused on read:false (${denied.result.error}), issued on read:true`,
					)
				: fail(
						`the managing app authorised but the credential was refused: ${describe(allowed.result)}`,
					);
		} finally {
			inbox.respond(lxm, undefined);
			await deleteProbeSpace(ctx, space.uri);
		}
	},
);

/** The crypto-bound catalog, in descriptor order. */
export const cryptoChecks: Check[] = [
	macCommit,
	macRecord,
	oplogFolds,
	getRepoStar,
	credentialSigned,
	delegationSigned,
	exportSpaceMeta,
	importSpaceMeta,
	importMetaNotAuthority,
	importMetaUnsupported,
	importMetaInvalid,
	importRepo,
	importRepoNotFound,
	importRepoInvalid,
	importRepoMismatch,
	memberGate,
	personalOnly,
	delegationWrongAud,
	notifyAccepted,
	notifyFuture,
	notifyUnknown,
	writeRevocation,
	revocationRefused,
	revocationName,
	revocationStranger,
	managedAccount,
];
