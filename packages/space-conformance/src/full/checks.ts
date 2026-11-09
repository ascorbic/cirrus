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
	serializeRepo,
	serializeSpaceMeta,
	spaceHostAud,
	verifyCommit,
	verifyRecord,
	verifyRepoStarFull,
	verifySpaceToken,
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
} from "../encoding.js";
import { resolveDidDocument, verificationMethodDidKey } from "../did.js";
import { createCredentialKey } from "../space-auth.js";
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
import { fakeDid } from "../checks/space.js";
import {
	collectBytes,
	commitFromJson,
	mintCredential,
	mintDelegation,
	obtainCredential,
	responseMac,
	serviceJwt,
} from "./helpers.js";

const crypto$ = (
	id: string,
	run: (ctx: CheckContext) => Promise<CheckOutcome>,
): Check => defineCheck({ ...descriptor(id), run });

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
		const res = await credentialGet(
			ctx,
			credential,
			"com.atproto.space.getLatestCommit",
			{
				space,
				repo: ctx.target.did,
			},
		);
		if (res.status !== 200)
			return fail(`getLatestCommit ${describe(res)}`, res.json);
		const raw = (res.json as { commit?: Record<string, unknown> }).commit ?? {};
		const keys = Object.keys(raw).sort().join(",");
		if (keys !== "data,repo,rev,space,ver") {
			return fail(
				`commit carries {${keys}}, expected exactly {data,repo,rev,space,ver}`,
				raw,
			);
		}
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
		const mac = responseMac(res);
		if (!mac)
			return fail("no parseable Atproto-Space-Mac header on a MAC'd read");
		return verifyCommit(commit, {
			space,
			repo: ctx.target.did,
			sharedSecret: res.sharedSecret!,
			mac,
		})
			? pass("commit shape as specified; its MAC verifies")
			: fail("the commit MAC does not verify", raw);
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
		const mac = responseMac(res);
		if (!mac)
			return fail("no parseable Atproto-Space-Mac header on a MAC'd read");
		const ok = await verifyRecord(record as never, {
			uri: record.uri,
			sharedSecret: res.sharedSecret!,
			mac,
		});
		return ok
			? pass("record MAC verifies over uri and cid; value encodes to cid")
			: fail("verifyRecord rejected the response", record);
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
		const res = await credentialGet(
			ctx,
			credential,
			"com.atproto.space.listRepoOps",
			{
				space,
				repo: ctx.target.did,
			},
		);
		if (res.status !== 200)
			return fail(`listRepoOps ${describe(res)}`, res.json);
		const body = res.json as {
			ops: Array<{
				collection: string;
				rkey: string;
				cid: string | null;
				prev: string | null;
			}>;
			commit?: unknown;
		};
		const commit = commitFromJson(body.commit);
		if (!commit)
			return fail("listRepoOps reached the head but returned no commit", body);
		const mac = responseMac(res);
		if (!mac)
			return fail("a page with the commit carried no Atproto-Space-Mac header");
		if (
			!verifyCommit(commit, {
				space,
				repo: ctx.target.did,
				sharedSecret: res.sharedSecret!,
				mac,
			})
		) {
			return fail("the head commit's MAC does not verify");
		}
		const folded = new RepoCommit().applyOps(
			body.ops.map((op) => ({
				collection: op.collection,
				rkey: op.rkey,
				cid: op.cid ? parseCid(op.cid) : null,
				prev: op.prev ? parseCid(op.prev) : null,
			})) as never,
		);
		return folded.matches(commit)
			? pass(`${body.ops.length} ops fold to the MAC-verified commit data`)
			: fail("the folded oplog does not match the commit data");
	}),
);

const getRepoStar = crypto$("sync.getrepo-star", (ctx) =>
	withPublicSpace(ctx, async (space, credential) => {
		const res = await credentialGet(
			ctx,
			credential,
			"com.atproto.space.getRepo",
			{
				space,
				repo: ctx.target.did,
			},
		);
		if (res.status !== 200) return fail(`getRepo ${describe(res)}`, res.json);
		const type = res.headers.get("Content-Type") ?? "";
		if (!type.includes("application/octet-stream"))
			return fail(`getRepo content-type was ${type}`);
		const mac = responseMac(res);
		if (!mac)
			return fail("no parseable Atproto-Space-Mac header on a MAC'd getRepo");
		const bytes = new Uint8Array(await res.response.arrayBuffer());
		try {
			const { records } = await verifyRepoStarFull([bytes], {
				space,
				repo: ctx.target.did,
				sharedSecret: res.sharedSecret!,
				mac,
			});
			const rkeys = records.map((r) => `${r.collection}/${r.rkey}`).sort();
			return rkeys.join(",") === `${POST}/a,${POST}/b`
				? pass("STAR archive verified against its MAC; both records present")
				: fail(`archive verified but held ${rkeys.join(", ") || "no records"}`);
		} catch (err) {
			return fail(
				`verifyRepoStarFull rejected the archive: ${(err as Error).message}`,
			);
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
				return fail(`credential did not verify: ${(err as Error).message}`);
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
					aud: spaceHostAud(ctx.target.did),
					sub: space.uri,
				},
			);
			return pass("verifies against the user's #atproto key");
		} catch (err) {
			return fail(`delegation token did not verify: ${(err as Error).message}`);
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
	if (res.status !== 200) {
		throw new Error(
			`exportSpaceMeta ${res.status} ${await res.text().catch(() => "")}`,
		);
	}
	return {
		type: res.headers.get("Content-Type") ?? "",
		archive: await readSpaceMetaStar([new Uint8Array(await res.arrayBuffer())]),
	};
}

const importMeta = async (ctx: CheckContext, archive: SpaceMetaArchive) =>
	xrpcPostBytes(
		asOperator(ctx),
		"com.atproto.space.importSpaceMeta",
		await collectBytes(serializeSpaceMeta(archive)),
	);

const memberKey = (did: string) => `com.atproto.memberspace.member/${did}`;

const exportSpaceMeta = crypto$("migration.export-space-meta", async (ctx) => {
	const space = await createProbeSpace(ctx, memberspace({ publicWrite: true }));
	const member = fakeDid();
	try {
		await xrpcPost(asOperator(ctx), "com.atproto.memberspace.putMember", {
			space: space.uri,
			did: member,
			read: true,
			write: false,
		});
		await mustCreateRecord(ctx, space.uri, "a");
		const { type, archive } = await exportMeta(ctx, space.uri);
		const problems: string[] = [];
		if (!type.includes("application/octet-stream"))
			problems.push(`content-type ${type}`);
		if (archive.space !== space.uri) problems.push(`space ${archive.space}`);
		if (archive.policy.$type !== "com.atproto.memberspace.policy")
			problems.push(`policy ${String(archive.policy.$type)}`);
		const entry = archive.policyState.find((e) => e.key === memberKey(member));
		if (!entry || entry.value.read !== true || entry.value.write !== false)
			problems.push("member entry missing or wrong");
		if (!archive.writers.some((w) => w.did === ctx.target.did))
			problems.push("the authority is not in the writer set");
		return problems.length
			? fail(problems.join("; "), archive)
			: pass("archive carries the policy, the member and the writer set");
	} catch (err) {
		return fail((err as Error).message);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const importSpaceMeta = crypto$("migration.import-space-meta", async (ctx) => {
	const space = await createProbeSpace(ctx, memberspace());
	const before = fakeDid();
	const after = fakeDid();
	try {
		await xrpcPost(asOperator(ctx), "com.atproto.memberspace.putMember", {
			space: space.uri,
			did: before,
			read: true,
			write: true,
		});
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
		return fail((err as Error).message);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const importMetaNotOwner = crypto$(
	"migration.import-space-meta-not-owner",
	async (ctx) => {
		const res = await importMeta(ctx, {
			space: unknownSpaceUri(FOREIGN_DID) as never,
			policy: { $type: "com.atproto.personalspace.policy" },
			policyState: [],
			writers: [],
		});
		return res.error === "NotSpaceOwner"
			? pass("answered NotSpaceOwner")
			: fail(`answered ${describe(res)}, expected NotSpaceOwner`, res.json);
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
			{
				space: space.uri,
				repo: ctx.target.did,
			},
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
			{
				space: space.uri,
				repo: ctx.target.did,
			},
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
			? pass("records replaced from the archive; same data, new rev")
			: fail(`rev ${now.rev} did not advance past the archive's ${commit.rev}`);
	} catch (err) {
		return fail((err as Error).message);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const importRepoNotFound = crypto$(
	"migration.import-repo-space-not-found",
	async (ctx) => {
		// A well-formed archive of an empty repo in an own space this host has
		// never heard of: the authority's space must be imported first.
		const space = `at://${ctx.target.did}/space/${PROBE_TYPE}/${probeSkey()}`;
		const commit = new RepoCommit().toCommit({
			space: space as never,
			repo: ctx.target.did as never,
			rev: tidNow(),
		});
		const res = await xrpcPostBytes(
			asOperator(ctx),
			"com.atproto.space.importRepo",
			await collectBytes(serializeRepo(commit, [])),
		);
		if (res.status === 200) await deleteProbeSpace(ctx, space);
		return res.error === "SpaceNotFound"
			? pass("answered SpaceNotFound")
			: fail(`answered ${describe(res)}, expected SpaceNotFound`, res.json);
	},
);

// --- foreign identities --------------------------------------------------

const isUserRefusal = (error?: string) =>
	error === "SpaceNotFound" ||
	error === "UserNotAuthorized" ||
	error === "NotAuthorized";

const memberGate = crypto$("credential.member-gate", async (ctx) => {
	const reader = await ctx.identities!.identity("reader");
	const space = await createProbeSpace(ctx, memberspace());
	const put = (read: boolean) =>
		xrpcPost(asOperator(ctx), "com.atproto.memberspace.putMember", {
			space: space.uri,
			did: reader.did,
			read,
			write: false,
		});
	try {
		await mustCreateRecord(ctx, space.uri, "shared", "members only");
		const stranger = await obtainCredential(ctx, reader, space.uri);
		if (stranger.credential) return fail("a non-member obtained a credential");
		if (!isUserRefusal(stranger.result.error)) {
			return fail(
				`non-member refused with ${describe(stranger.result)}; expected SpaceNotFound, UserNotAuthorized or NotAuthorized`,
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
			return fail("a personalspace issued a credential to another user");
		return isUserRefusal(res.result.error)
			? pass(`refused with ${res.result.error}`)
			: fail(
					`refused with ${describe(res.result)}; expected SpaceNotFound, UserNotAuthorized or NotAuthorized`,
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
			await xrpcPost(asOperator(ctx), "com.atproto.memberspace.putMember", {
				space: space.uri,
				did: reader.did,
				read: true,
				write: false,
			});
			// Positive control: with the right audience the reader is admitted, so
			// the refusal below is the audience's and not an unresolvable reader.
			const control = await obtainCredential(ctx, reader, space.uri);
			if (!control.credential) {
				return fail(
					`correct-aud control failed (${describe(control.result)}); cannot attribute the wrong-aud refusal`,
				);
			}
			const { result, credential } = await obtainCredential(
				ctx,
				reader,
				space.uri,
				{
					audOverride: `${FOREIGN_DID}#atproto_pds`,
				},
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

async function notifyWrite(
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
		aud: spaceHostAud(ctx.target.did),
		lxm: "com.atproto.space.notifyWrite",
	});
	return xrpcPost(
		ctx,
		"com.atproto.space.notifyWrite",
		{
			space,
			repo: writer.did,
			repoRev,
			data: { $bytes: toBase64(data).replace(/=+$/, "") },
		},
		{ Authorization: `Bearer ${jwt}` },
	);
}

const notifyAccepted = crypto$("host.notifywrite-accepted", async (ctx) => {
	const writer = await ctx.identities!.identity("writer");
	const space = await createProbeSpace(ctx, memberspace({ publicRead: true }));
	try {
		await xrpcPost(asOperator(ctx), "com.atproto.memberspace.putMember", {
			space: space.uri,
			did: writer.did,
			read: false,
			write: true,
		});
		const repoRev = tidNow();
		const data = globalThis.crypto.getRandomValues(new Uint8Array(32));
		const res = await notifyWrite(ctx, writer, space.uri, repoRev, data);
		if (res.status !== 200)
			return fail(`notifyWrite ${describe(res)}`, res.json);
		const credential = await obtainPublicCredential(ctx, space.uri);
		const list = await credentialCall(
			ctx,
			credential,
			"com.atproto.space.listRepos",
			{
				params: { space: space.uri },
				audience: ctx.target.did,
			},
		);
		const entry = (
			(
				list.json as
					| { repos?: Array<{ did: string; repoRev: string; data: unknown }> }
					| undefined
			)?.repos ?? []
		).find((r) => r.did === writer.did);
		if (!entry)
			return fail("the notified writer is not in listRepos", list.json);
		const listed = lexBytes(entry.data);
		return entry.repoRev === repoRev && listed && bytesEqual(listed, data)
			? pass("accepted; listRepos reports the notified repoRev and data")
			: fail("listRepos entry does not match the notification", entry);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
});

const notifyFuture = crypto$("host.notifywrite-future-rev", async (ctx) => {
	const writer = await ctx.identities!.identity("writer");
	const space = await createProbeSpace(ctx, memberspace({ publicWrite: true }));
	try {
		const hourAhead = BigInt(Date.now() + 60 * 60 * 1000) * 1000n;
		const res = await notifyWrite(
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
});

const notifyUnknown = crypto$("host.notifywrite-unknown-space", async (ctx) => {
	const writer = await ctx.identities!.identity("writer");
	const res = await notifyWrite(
		ctx,
		writer,
		unknownSpaceUri(ctx.target.did),
		tidNow(),
		new Uint8Array(32),
	);
	return res.error === "SpaceNotFound"
		? pass("answered SpaceNotFound")
		: fail(`answered ${describe(res)}, expected SpaceNotFound`, res.json);
});

/**
 * The revocation flow: a harness identity plays a foreign space authority,
 * the operator writes into that space (as a member's PDS would), and the
 * authority's credential reads the operator's repo — until revoked.
 */
async function revocationFlow(
	ctx: CheckContext,
	revoker: "authority" | "stranger",
): Promise<{
	before: number;
	after?: { status: number; error?: string };
	revoke?: { status: number; error?: string };
	detail?: string;
}> {
	const authority = await ctx.identities!.identity("authority");
	const space = `at://${authority.did}/space/${PROBE_TYPE}/${probeSkey()}`;
	const write = await operatorCreateRecord(ctx, space, POST, "shared", {
		$type: POST,
		text: "for the authority",
	});
	if (write.status !== 200)
		return {
			before: write.status,
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
			before: before.status,
			detail: `foreign authority's credential could not read: ${describe(before)}`,
		};
	const signer =
		revoker === "authority"
			? authority
			: await ctx.identities!.identity("stranger");
	const jwt = await serviceJwt(signer, {
		aud: ctx.target.did,
		lxm: "com.atproto.space.notifyCredentialRevoked",
	});
	const { payload } = decodeJwt(credential.credential);
	const revoke = await xrpcPost(
		ctx,
		"com.atproto.space.notifyCredentialRevoked",
		{ space, credentials: [payload.jti] },
		{ Authorization: `Bearer ${jwt}` },
	);
	const after = await read();
	return { before: 200, revoke, after };
}

const revocationRefused = crypto$(
	"revocation.revoked-credential-refused",
	async (ctx) => {
		const flow = await revocationFlow(ctx, "authority");
		if (flow.detail) return fail(flow.detail);
		if (flow.revoke!.status !== 200)
			return fail(
				`notifyCredentialRevoked ${flow.revoke!.status} ${flow.revoke!.error ?? ""}`,
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

const managedSpace = crypto$("managedspace.checkuseraccess", async (ctx) => {
	const inbox = ctx.syncerInbox!;
	const reader = await ctx.identities!.identity("reader");
	const lxm = "com.atproto.managedspace.checkUserAccess";
	let decision = false;
	inbox.respond(lxm, () => ({ authorized: decision }));
	const space = await createProbeSpace(ctx, managedspace(inbox.service));
	try {
		const since = Date.now();
		const denied = await obtainCredential(ctx, reader, space.uri);
		if (denied.credential)
			return fail("issued a credential the managing app refused");
		const asked = await inbox.waitFor(
			(d) => d.lxm === lxm && d.receivedAt >= since,
			5_000,
		);
		if (!asked)
			return fail(
				`the managing app was never asked (${describe(denied.result)})`,
			);
		const p = asked.params ?? {};
		if (p.space !== space.uri || p.user !== reader.did || p.access !== "read") {
			return fail("checkUserAccess carried the wrong params", p);
		}
		if (!asked.authorization?.startsWith("Bearer "))
			return fail("checkUserAccess was sent without service auth");
		decision = true;
		const allowed = await obtainCredential(ctx, reader, space.uri);
		return allowed.credential
			? pass(
					`asked the managing app (space, user, access=read); refused on false (${denied.result.error}), issued on true`,
				)
			: fail(
					`the managing app authorised but the credential was refused: ${describe(allowed.result)}`,
				);
	} finally {
		inbox.respond(lxm, undefined);
		await deleteProbeSpace(ctx, space.uri);
	}
});

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
	importMetaNotOwner,
	importMetaUnsupported,
	importRepo,
	importRepoNotFound,
	memberGate,
	personalOnly,
	delegationWrongAud,
	notifyAccepted,
	notifyFuture,
	notifyUnknown,
	revocationRefused,
	revocationName,
	revocationStranger,
	managedSpace,
];
