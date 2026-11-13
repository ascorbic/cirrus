/**
 * Space management and the baseline policies: createSpace / updateSpace /
 * deleteSpace / getSpace / listSpaces, and the memberspace member list.
 * Operator-only and browser-safe.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost } from "../http.js";
import { fail, pass, type Check, type CheckContext } from "../model.js";
import { bytesEqual, isTid, lexBytes, toBase32 } from "../encoding.js";
import {
	FOREIGN_DID,
	PROBE_TYPE,
	createProbeSpace,
	credentialCall,
	deleteProbeSpace,
	describe,
	errorIs,
	expectEach,
	managedspace,
	memberspace,
	mustCreateRecord,
	obtainPublicCredential,
	operatorGetRecord,
	personalspace,
	probeSkey,
	publicRead,
	unknownSpaceUri,
	type Policy,
} from "./probe.js";

const L = (ref: string) => ({ source: "lexicon" as const, ref });
const C = (ref: string) => ({ source: "changeset" as const, ref });
const P = (ref: string) => ({ source: "proposal" as const, ref });

/** A syntactically valid did:plc nobody registered — a member to list. */
export function fakeDid(): string {
	return `did:plc:${toBase32(crypto.getRandomValues(new Uint8Array(15))).slice(0, 24)}`;
}

const op = asOperator;

type Member = { did: string; read: boolean; write: boolean };

export const putMembers = (
	ctx: CheckContext,
	space: string,
	members: Member[],
) =>
	xrpcPost(op(ctx), "com.atproto.memberspace.putMembers", { space, members });

const removeMembers = (
	ctx: CheckContext,
	space: string,
	dids: string[],
) =>
	xrpcPost(op(ctx), "com.atproto.memberspace.removeMembers", { space, dids });

async function listMembers(
	ctx: CheckContext,
	space: string,
): Promise<Member[]> {
	const res = await xrpcGet(op(ctx), "com.atproto.memberspace.listMembers", {
		space,
		limit: "100",
	});
	if (res.status !== 200) throw new Error(`listMembers ${describe(res)}`);
	return (res.json as { members?: Member[] }).members ?? [];
}

// --- create / get -------------------------------------------------------

const spaceCreateAndGet = defineCheck({
	id: "space.create-and-get",
	title:
		"createSpace anchors the space on the operator and getSpace describes it",
	tier: "must",
	citations: [
		L("com.atproto.space.createSpace"),
		L("com.atproto.space.getSpace"),
		P("0016#addressing"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const skey = probeSkey();
		const res = await xrpcPost(op(ctx), "com.atproto.space.createSpace", {
			spaceType: PROBE_TYPE,
			skey,
			policy: memberspace(),
		});
		if (res.status !== 200)
			return fail(`createSpace ${describe(res)}`, res.json);
		const uri = (res.json as { space?: string }).space;
		try {
			const expected = `at://${ctx.target.did}/space/${PROBE_TYPE}/${skey}`;
			if (uri !== expected) {
				return fail(
					`createSpace returned space ${uri}, expected ${expected}`,
					res.json,
				);
			}
			const got = await xrpcGet(op(ctx), "com.atproto.space.getSpace", {
				space: uri,
			});
			if (got.status !== 200)
				return fail(`getSpace ${describe(got)}`, got.json);
			const body = got.json as { space?: string; policy?: Policy };
			if (body.space !== uri)
				return fail(`getSpace space was ${body.space}`, got.json);
			if (body.policy?.$type !== "com.atproto.memberspace.policy") {
				return fail(`getSpace policy was ${body.policy?.$type}`, got.json);
			}
			// Defaults are false: an unset publicRead must not read as public.
			return body.policy.publicRead === true
				? fail(
						"a memberspace created without publicRead reports publicRead: true",
					)
				: pass(
						"created at the expected ref; getSpace reports the memberspace policy",
					);
		} finally {
			if (uri) await deleteProbeSpace(ctx, uri);
		}
	},
});

const spaceGeneratedSkey = defineCheck({
	id: "space.create-generates-skey",
	title: "createSpace without an skey generates a TID",
	tier: "must",
	citations: [L("com.atproto.space.createSpace")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const res = await xrpcPost(op(ctx), "com.atproto.space.createSpace", {
			spaceType: PROBE_TYPE,
			policy: personalspace(),
		});
		if (res.status !== 200)
			return fail(`createSpace ${describe(res)}`, res.json);
		const uri = (res.json as { space: string }).space;
		await deleteProbeSpace(ctx, uri);
		const skey = uri?.split("/").at(-1);
		return isTid(skey)
			? pass(`generated skey ${skey}`)
			: fail(`generated skey ${skey} is not a TID`);
	},
});

const spaceDuplicate = defineCheck({
	id: "space.duplicate-refused",
	title: "Creating an existing space is refused with SpaceAlreadyExists",
	tier: "must",
	citations: [L("com.atproto.space.createSpace@error:SpaceAlreadyExists")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, personalspace());
		try {
			const again = await xrpcPost(op(ctx), "com.atproto.space.createSpace", {
				spaceType: PROBE_TYPE,
				skey: space.skey,
				policy: personalspace(),
			});
			if (again.status === 200)
				return fail("a second createSpace at the same skey returned 200");
			return again.error === "SpaceAlreadyExists"
				? pass("refused with SpaceAlreadyExists")
				: fail(
						`refused with ${describe(again)}, expected SpaceAlreadyExists`,
						again.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const spaceRecreate = defineCheck({
	id: "space.recreate-after-delete",
	title: "A deleted space may be created again",
	tier: "must",
	citations: [P("0016#space-deletion"), L("com.atproto.space.createSpace")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// "An authority MAY recreate a deleted space with the same space type
		// and skey" — so a host must let it.
		const space = await createProbeSpace(ctx, personalspace());
		await deleteProbeSpace(ctx, space.uri);
		const again = await xrpcPost(op(ctx), "com.atproto.space.createSpace", {
			spaceType: PROBE_TYPE,
			skey: space.skey,
			policy: personalspace(),
		});
		await deleteProbeSpace(ctx, space.uri);
		return again.status === 200
			? pass("re-created the deleted space")
			: fail(
					`re-creating a deleted space returned ${describe(again)}`,
					again.json,
				);
	},
});

const spaceUnsupportedPolicy = defineCheck({
	id: "space.unsupported-policy-rejected",
	title:
		"createSpace and updateSpace refuse a policy the host does not implement",
	tier: "must",
	citations: [
		L("com.atproto.space.createSpace@error:UnsupportedPolicy"),
		L("com.atproto.space.updateSpace@error:UnsupportedPolicy"),
		P("0016#space-policy"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const mystery = { $type: "com.example.mysteryPolicy" };
		const space = await createProbeSpace(ctx, personalspace());
		let created: string | undefined;
		try {
			const result = await expectEach([
				[
					"createSpace",
					async () => {
						const res = await xrpcPost(
							op(ctx),
							"com.atproto.space.createSpace",
							{
								spaceType: PROBE_TYPE,
								skey: probeSkey(),
								policy: mystery,
							},
						);
						if (res.status === 200)
							created = (res.json as { space: string }).space;
						return res;
					},
					errorIs("UnsupportedPolicy"),
				],
				[
					"updateSpace",
					() =>
						xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
							space: space.uri,
							policy: mystery,
						}),
					errorIs("UnsupportedPolicy"),
				],
			]);
			return result.ok
				? pass("both refused with UnsupportedPolicy")
				: fail(`expected UnsupportedPolicy: ${result.detail}`, result.evidence);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
			if (created) await deleteProbeSpace(ctx, created);
		}
	},
});

const spaceUpdateReplaces = defineCheck({
	id: "space.update-replaces-policy",
	title:
		"updateSpace replaces the policy wholesale; a type change discards member state",
	tier: "must",
	citations: [
		L("com.atproto.space.updateSpace"),
		L("com.atproto.space.getSpace"),
		L("com.atproto.memberspace.listMembers"),
		P("0016#space-policy"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		const member = fakeDid();
		const policyOf = async () =>
			(
				(
					await xrpcGet(op(ctx), "com.atproto.space.getSpace", {
						space: space.uri,
					})
				).json as { policy?: Policy } | undefined
			)?.policy;
		const update = (policy: Policy) =>
			xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
				space: space.uri,
				policy,
			});
		try {
			await putMembers(ctx, space.uri, [
				{ did: member, read: true, write: false },
			]);
			// Same type: a configuration change. The member list survives.
			const same = await update(memberspace({ publicRead: true }));
			if (same.status !== 200)
				return fail(`updateSpace (config) ${describe(same)}`, same.json);
			if ((await policyOf())?.publicRead !== true)
				return fail("getSpace does not reflect publicRead: true");
			if (!(await listMembers(ctx, space.uri)).some((m) => m.did === member)) {
				return fail("a same-type update dropped the member list");
			}
			// A different type migrates the space.
			const migrate = await update(personalspace());
			if (migrate.status !== 200)
				return fail(`updateSpace (migrate) ${describe(migrate)}`, migrate.json);
			const p2 = await policyOf();
			if (p2?.$type !== "com.atproto.personalspace.policy") {
				return fail(`after migration getSpace reports ${p2?.$type}`, p2);
			}
			// Migrating back does not restore the discarded member list.
			const back = await update(memberspace());
			if (back.status !== 200)
				return fail(`updateSpace (back) ${describe(back)}`, back.json);
			return (await listMembers(ctx, space.uri)).some((m) => m.did === member)
				? fail("migrating away and back restored the old member list")
				: pass(
						"config update kept members; a type change replaced the policy and discarded them",
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const spaceNotAuthority = defineCheck({
	id: "space.not-authority-refused",
	title:
		"Managing a space anchored on another DID is refused with NotAuthorized",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteSpace@error:NotAuthorized"),
		L("com.atproto.space.updateSpace@error:NotAuthorized"),
		L("com.atproto.space.getSpace@error:NotAuthorized"),
		L("com.atproto.space.removeWriter@error:NotAuthorized"),
		L("com.atproto.space.exportSpaceMeta@error:NotAuthorized"),
		L("com.atproto.memberspace.putMembers@error:NotAuthorized"),
		L("com.atproto.memberspace.removeMembers@error:NotAuthorized"),
		L("com.atproto.memberspace.listMembers@error:NotAuthorized"),
	],
	needs: ["operator"],
	async run(ctx) {
		const space = unknownSpaceUri(FOREIGN_DID);
		const did = fakeDid();
		const na = errorIs("NotAuthorized");
		const result = await expectEach([
			[
				"deleteSpace",
				() => xrpcPost(op(ctx), "com.atproto.space.deleteSpace", { space }),
				na,
			],
			[
				"updateSpace",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
						space,
						policy: personalspace(),
					}),
				na,
			],
			[
				"getSpace",
				() => xrpcGet(op(ctx), "com.atproto.space.getSpace", { space }),
				na,
			],
			[
				"removeWriter",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.removeWriter", {
						space,
						repo: did,
					}),
				na,
			],
			[
				"exportSpaceMeta",
				() => xrpcGet(op(ctx), "com.atproto.space.exportSpaceMeta", { space }),
				na,
			],
			[
				"putMembers",
				() => putMembers(ctx, space, [{ did, read: true, write: true }]),
				na,
			],
			["removeMembers", () => removeMembers(ctx, space, [did]), na],
			[
				"listMembers",
				() =>
					xrpcGet(op(ctx), "com.atproto.memberspace.listMembers", { space }),
				na,
			],
		]);
		return result.ok
			? pass("every authority-only method answered NotAuthorized")
			: fail(`expected NotAuthorized: ${result.detail}`, result.evidence);
	},
});

const spaceUnknown = defineCheck({
	id: "space.unknown-space-not-found",
	title: "Managing an own space that does not exist answers SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.getSpace@error:SpaceNotFound"),
		L("com.atproto.space.updateSpace@error:SpaceNotFound"),
		L("com.atproto.space.deleteSpace@error:SpaceNotFound"),
		L("com.atproto.space.exportSpaceMeta@error:SpaceNotFound"),
		L("com.atproto.space.removeWriter@error:SpaceNotFound"),
		L("com.atproto.memberspace.putMembers@error:SpaceNotFound"),
		L("com.atproto.memberspace.removeMembers@error:SpaceNotFound"),
		L("com.atproto.memberspace.listMembers@error:SpaceNotFound"),
	],
	needs: ["operator"],
	async run(ctx) {
		const space = unknownSpaceUri(ctx.target.did);
		const did = fakeDid();
		const nf = errorIs("SpaceNotFound");
		const result = await expectEach([
			[
				"getSpace",
				() => xrpcGet(op(ctx), "com.atproto.space.getSpace", { space }),
				nf,
			],
			[
				"updateSpace",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
						space,
						policy: personalspace(),
					}),
				nf,
			],
			[
				"deleteSpace",
				() => xrpcPost(op(ctx), "com.atproto.space.deleteSpace", { space }),
				nf,
			],
			[
				"exportSpaceMeta",
				() => xrpcGet(op(ctx), "com.atproto.space.exportSpaceMeta", { space }),
				nf,
			],
			[
				"removeWriter",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.removeWriter", {
						space,
						repo: did,
					}),
				nf,
			],
			[
				"putMembers",
				() => putMembers(ctx, space, [{ did, read: true, write: false }]),
				nf,
			],
			["removeMembers", () => removeMembers(ctx, space, [did]), nf],
			[
				"listMembers",
				() =>
					xrpcGet(op(ctx), "com.atproto.memberspace.listMembers", { space }),
				nf,
			],
		]);
		return result.ok
			? pass("every method answered SpaceNotFound")
			: fail(`expected SpaceNotFound: ${result.detail}`, result.evidence);
	},
});

const spaceDeleteIdempotent = defineCheck({
	id: "space.delete-idempotent",
	title: "Deleting an already-deleted space succeeds",
	tier: "should",
	citations: [
		{
			source: "reference",
			ref: "pds deleteSpace returns early for a tombstoned space",
		},
		L("com.atproto.space.deleteSpace"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The 1105 lexicon called deleteSpace idempotent; 1112 dropped the
		// sentence, so this is now calibrated against the reference.
		const space = await createProbeSpace(ctx, personalspace());
		const first = await xrpcPost(op(ctx), "com.atproto.space.deleteSpace", {
			space: space.uri,
		});
		const second = await xrpcPost(op(ctx), "com.atproto.space.deleteSpace", {
			space: space.uri,
		});
		return first.status === 200 && second.status === 200
			? pass("both deletes returned 200")
			: fail(`deletes returned ${describe(first)} then ${describe(second)}`);
	},
});

const spaceListSpaces = defineCheck({
	id: "space.listspaces-filters",
	title:
		"listSpaces lists the operator's spaces with its repo state, honouring spaceType and spaceDid",
	tier: "must",
	citations: [
		L("com.atproto.space.listSpaces"),
		L("com.atproto.space.listSpaces#spaceView"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, personalspace());
		try {
			await mustCreateRecord(ctx, space.uri, "a");
			// Filter on both: an OAuth grant scoped to the probe type under the
			// operator's authority covers exactly this listing.
			const seen: Array<{
				space: string;
				repoRev?: string;
				data?: unknown;
				spaceRev?: string;
			}> = [];
			let cursor: string | undefined;
			for (let page = 0; page < 20; page++) {
				const res = await xrpcGet(op(ctx), "com.atproto.space.listSpaces", {
					spaceType: PROBE_TYPE,
					spaceDid: ctx.target.did,
					limit: "100",
					cursor,
				});
				if (res.status !== 200)
					return fail(`listSpaces ${describe(res)}`, res.json);
				const body = res.json as { spaces?: typeof seen; cursor?: string };
				seen.push(...(body.spaces ?? []));
				cursor = body.cursor;
				if (!cursor || seen.some((s) => s.space === space.uri)) break;
			}
			const entry = seen.find((s) => s.space === space.uri);
			if (!entry) return fail("listSpaces did not list the new space");
			const stray = seen.filter(
				(s) =>
					!s.space.startsWith(`at://${ctx.target.did}/space/${PROBE_TYPE}/`),
			);
			if (stray.length)
				return fail(
					`listing included spaces outside the filter: ${stray.map((s) => s.space).join(", ")}`,
				);
			// The entry carries the operator's repo state, and — as authority — the spaceRev.
			const latest = await xrpcGet(
				op(ctx),
				"com.atproto.space.getLatestCommit",
				{
					space: space.uri,
					repo: ctx.target.did,
				},
			);
			const commit = (
				latest.json as { commit?: { rev?: string; data?: unknown } } | undefined
			)?.commit;
			const a = lexBytes(entry.data);
			const b = lexBytes(commit?.data);
			const problems: string[] = [];
			if (entry.repoRev !== commit?.rev)
				problems.push(`repoRev ${entry.repoRev} ≠ commit rev ${commit?.rev}`);
			if (!a || !b || !bytesEqual(a, b))
				problems.push("data does not match the commit");
			if (!isTid(entry.spaceRev))
				problems.push(`no spaceRev for a space the caller is authority of`);
			return problems.length
				? fail(problems.join("; "), entry)
				: pass("listed with the operator's repoRev, data and the spaceRev");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const spaceOwnerStateNotByCredential = defineCheck({
	id: "space.owner-state-not-by-credential",
	title:
		"A space credential does not reach getSpace, listMembers or exportSpaceMeta",
	tier: "must",
	citations: [
		L("com.atproto.space.getSpace"),
		L("com.atproto.memberspace.listMembers"),
		L("com.atproto.space.exportSpaceMeta"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// Each requires auth as the space authority: the policy and member list
		// are its own state, and a credential — which any reader of a public
		// space can hold — must not expose them.
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			const call = (nsid: string) =>
				credentialCall(ctx, credential, nsid, {
					params: { space: space.uri },
					audience: ctx.target.did,
				});
			const result = await expectEach([
				[
					"getSpace",
					() => call("com.atproto.space.getSpace"),
					(r) => r.status !== 200,
				],
				[
					"listMembers",
					() => call("com.atproto.memberspace.listMembers"),
					(r) => r.status !== 200,
				],
				[
					"exportSpaceMeta",
					() => call("com.atproto.space.exportSpaceMeta"),
					(r) => r.status !== 200,
				],
			]);
			return result.ok
				? pass(`all refused (${Object.values(result.evidence).join(", ")})`)
				: fail(`served to a credential: ${result.detail}`, result.evidence);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const managedBareDid = defineCheck({
	id: "managedspace.bare-did-rejected",
	title:
		"A managedspace whose managingApp is not a did#serviceId reference is refused",
	tier: "must",
	citations: [L("com.atproto.managedspace.policy"), C("tidy-spaces-settle")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const res = await xrpcPost(op(ctx), "com.atproto.space.createSpace", {
			spaceType: PROBE_TYPE,
			skey: probeSkey(),
			policy: managedspace(FOREIGN_DID),
		});
		if (res.status === 200) {
			await deleteProbeSpace(ctx, (res.json as { space: string }).space);
			return fail("created a managedspace whose managingApp is a bare DID");
		}
		return res.status >= 400 && res.status < 500
			? pass(`refused (${describe(res)})`)
			: fail(`answered ${describe(res)}`, res.json);
	},
});

// --- memberspace ------------------------------------------------------

const memberRoundTrip = defineCheck({
	id: "memberspace.member-round-trip",
	title: "putMembers and removeMembers apply batches; listMembers follows",
	tier: "must",
	citations: [
		L("com.atproto.memberspace.putMembers"),
		L("com.atproto.memberspace.listMembers"),
		L("com.atproto.memberspace.removeMembers"),
		L("com.atproto.memberspace.defs#member"),
		C("tidy-spaces-settle"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		const [a, b] = [fakeDid(), fakeDid()];
		const find = (members: Member[], did: string) =>
			members.find((m) => m.did === did);
		try {
			// One batch; `a` appears twice and its last entry wins.
			const put = await putMembers(ctx, space.uri, [
				{ did: a, read: false, write: false },
				{ did: b, read: true, write: true },
				{ did: a, read: true, write: false },
			]);
			if (put.status !== 200)
				return fail(`putMembers ${describe(put)}`, put.json);
			const listed = await listMembers(ctx, space.uri);
			const ma = find(listed, a);
			const mb = find(listed, b);
			if (!ma || ma.read !== true || ma.write !== false)
				return fail(
					`a duplicated DID did not take its last entry: ${JSON.stringify(ma)}`,
				);
			if (!mb || mb.read !== true || mb.write !== true)
				return fail(`second member: ${JSON.stringify(mb)}`);
			// Replace one member's access.
			await putMembers(ctx, space.uri, [{ did: b, read: false, write: true }]);
			const mb2 = find(await listMembers(ctx, space.uri), b);
			if (!mb2 || mb2.read !== false || mb2.write !== true)
				return fail(
					`putMembers did not replace access: ${JSON.stringify(mb2)}`,
				);
			// removeMembers ignores DIDs that are not members.
			const removed = await removeMembers(ctx, space.uri, [a, b, fakeDid()]);
			if (removed.status !== 200)
				return fail(`removeMembers ${describe(removed)}`, removed.json);
			const left = await listMembers(ctx, space.uri);
			return find(left, a) || find(left, b)
				? fail(`removeMembers left ${JSON.stringify(left)}`)
				: pass(
						"batched put (last entry wins), replace, and remove (ignoring a non-member)",
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const memberPolicyMismatch = defineCheck({
	id: "memberspace.policy-mismatch",
	title: "Member methods on a non-memberspace answer PolicyMismatch",
	tier: "must",
	citations: [
		L("com.atproto.memberspace.putMembers@error:PolicyMismatch"),
		L("com.atproto.memberspace.removeMembers@error:PolicyMismatch"),
		L("com.atproto.memberspace.listMembers@error:PolicyMismatch"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, personalspace());
		const did = fakeDid();
		const mm = errorIs("PolicyMismatch");
		try {
			const result = await expectEach([
				[
					"putMembers",
					() => putMembers(ctx, space.uri, [{ did, read: true, write: true }]),
					mm,
				],
				["removeMembers", () => removeMembers(ctx, space.uri, [did]), mm],
				[
					"listMembers",
					() =>
						xrpcGet(op(ctx), "com.atproto.memberspace.listMembers", {
							space: space.uri,
						}),
					mm,
				],
			]);
			return result.ok
				? pass("all three answered PolicyMismatch on a personalspace")
				: fail(`expected PolicyMismatch: ${result.detail}`, result.evidence);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const memberPublish = defineCheck({
	id: "memberspace.publish-policy-and-members",
	title:
		"publishPolicy / publishMembers keep policy and member records in the authority's repo",
	tier: "must",
	citations: [
		L("com.atproto.memberspace.policy"),
		L("com.atproto.space.policy"),
		L("com.atproto.memberspace.member"),
		P("0016#publishing-to-readers"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(
			ctx,
			memberspace({ publishPolicy: true, publishMembers: true }),
		);
		const member = fakeDid();
		try {
			const policy = await operatorGetRecord(
				ctx,
				space.uri,
				"self",
				"com.atproto.space.policy",
			);
			if (policy.status !== 200)
				return fail(
					`no com.atproto.space.policy/self record: ${describe(policy)}`,
					policy.json,
				);
			const published = (policy.json as { value?: { policy?: Policy } }).value
				?.policy;
			if (
				published?.$type !== "com.atproto.memberspace.policy" ||
				published.publishMembers !== true
			) {
				return fail(
					"the published policy record does not carry the space's policy",
					policy.json,
				);
			}
			await putMembers(ctx, space.uri, [
				{ did: member, read: true, write: false },
			]);
			const rec = await operatorGetRecord(
				ctx,
				space.uri,
				member,
				"com.atproto.memberspace.member",
			);
			const value = (
				rec.json as { value?: { read?: boolean; write?: boolean } } | undefined
			)?.value;
			if (rec.status !== 200 || value?.read !== true || value.write !== false) {
				return fail(
					`member record after putMembers: ${describe(rec)}`,
					rec.json,
				);
			}
			await removeMembers(ctx, space.uri, [member]);
			const gone = await operatorGetRecord(
				ctx,
				space.uri,
				member,
				"com.atproto.memberspace.member",
			);
			return gone.status === 200
				? fail("the member record outlived removeMembers", gone.json)
				: pass(
						"policy record published; member record tracked putMembers and removeMembers",
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

export const spaceChecks: Check[] = [
	spaceCreateAndGet,
	spaceGeneratedSkey,
	spaceDuplicate,
	spaceRecreate,
	spaceUnsupportedPolicy,
	spaceUpdateReplaces,
	spaceNotAuthority,
	spaceUnknown,
	spaceDeleteIdempotent,
	spaceListSpaces,
	spaceOwnerStateNotByCredential,
	managedBareDid,
	memberRoundTrip,
	memberPolicyMismatch,
	memberPublish,
];
