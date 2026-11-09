/**
 * Space management and the baseline policies: createSpace / updateSpace /
 * deleteSpace / getSpace / listSpaces, and the memberspace member list.
 * Operator-only and browser-safe.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost, type XrpcResult } from "../http.js";
import { fail, pass, type Check, type CheckContext } from "../model.js";
import { isTid, toBase32 } from "../encoding.js";
import {
	FOREIGN_DID,
	PROBE_TYPE,
	createProbeSpace,
	credentialCall,
	deleteProbeSpace,
	describe,
	memberspace,
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

/** A syntactically valid did:plc nobody registered — a member to list. */
export function fakeDid(): string {
	return `did:plc:${toBase32(crypto.getRandomValues(new Uint8Array(15))).slice(0, 24)}`;
}

const op = asOperator;

/** Run named probes and fail with every one that missed, not just the first. */
async function expectEach(
	probes: Array<
		[string, () => Promise<XrpcResult>, (r: XrpcResult) => boolean]
	>,
): Promise<{ ok: boolean; detail: string; evidence: Record<string, string> }> {
	const evidence: Record<string, string> = {};
	const misses: string[] = [];
	for (const [name, call, accept] of probes) {
		const res = await call();
		evidence[name] = describe(res);
		if (!accept(res)) misses.push(`${name} → ${describe(res)}`);
	}
	return {
		ok: misses.length === 0,
		detail: misses.join("; "),
		evidence,
	};
}

const errorIs = (name: string) => (r: XrpcResult) => r.error === name;

// --- create / get -------------------------------------------------------

const spaceCreateAndGet = defineCheck({
	id: "space.create-and-get",
	title:
		"createSpace anchors the space on the operator and getSpace describes it",
	tier: "must",
	citations: [
		L("com.atproto.space.createSpace"),
		L("com.atproto.space.getSpace"),
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
		const uri = (res.json as { uri?: string }).uri;
		try {
			const expected = `at://${ctx.target.did}/space/${PROBE_TYPE}/${skey}`;
			if (uri !== expected)
				return fail(`createSpace returned ${uri}, expected ${expected}`);
			const got = await xrpcGet(op(ctx), "com.atproto.space.getSpace", {
				space: uri,
			});
			if (got.status !== 200)
				return fail(`getSpace ${describe(got)}`, got.json);
			const body = got.json as { uri?: string; policy?: Policy };
			if (body.uri !== uri)
				return fail(`getSpace uri was ${body.uri}`, got.json);
			if (body.policy?.$type !== "com.atproto.memberspace.policy") {
				return fail(`getSpace policy was ${body.policy?.$type}`, got.json);
			}
			// Defaults are false: an unset publicRead must not read as public.
			return body.policy.publicRead === true
				? fail(
						"a memberspace created without publicRead reports publicRead: true",
					)
				: pass(
						"created at the expected uri; getSpace reports the memberspace policy",
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
		const uri = (res.json as { uri: string }).uri;
		await deleteProbeSpace(ctx, uri);
		const skey = uri.split("/").at(-1);
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
	citations: [L("com.atproto.space.createSpace@error:SpaceAlreadyExists")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// The SpaceAlreadyExists declaration itself carves this out: "A space
		// that was previously deleted may be created again."
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
						if (res.status === 200) created = (res.json as { uri: string }).uri;
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
		const members = async () =>
			xrpcGet(op(ctx), "com.atproto.memberspace.listMembers", {
				space: space.uri,
			});
		const update = (policy: Policy) =>
			xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
				space: space.uri,
				policy,
			});
		try {
			await xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
				space: space.uri,
				did: member,
				read: true,
				write: false,
			});

			// Same type: a configuration change. The member list survives.
			const same = await update(memberspace({ publicRead: true }));
			if (same.status !== 200)
				return fail(`updateSpace (config) ${describe(same)}`, same.json);
			const p1 = await policyOf();
			if (p1?.publicRead !== true)
				return fail("getSpace does not reflect publicRead: true", p1);
			const kept = (await members()).json as {
				members?: Array<{ did: string }>;
			};
			if (!kept.members?.some((m) => m.did === member)) {
				return fail("a same-type update dropped the member list", kept);
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
			const after = (await members()).json as {
				members?: Array<{ did: string }>;
			};
			return after.members?.some((m) => m.did === member)
				? fail("migrating away and back restored the old member list", after)
				: pass(
						"config update kept members; a type change replaced the policy and discarded them",
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const spaceNotOwner = defineCheck({
	id: "space.not-owner-refused",
	title:
		"Managing a space anchored on another DID is refused with NotSpaceOwner",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteSpace@error:NotSpaceOwner"),
		L("com.atproto.space.updateSpace@error:NotSpaceOwner"),
		L("com.atproto.space.removeWriter@error:NotSpaceOwner"),
		L("com.atproto.space.exportSpaceMeta@error:NotSpaceOwner"),
		L("com.atproto.memberspace.putMember@error:NotSpaceOwner"),
		L("com.atproto.memberspace.removeMember@error:NotSpaceOwner"),
	],
	needs: ["operator"],
	async run(ctx) {
		const space = unknownSpaceUri(FOREIGN_DID);
		const did = fakeDid();
		const result = await expectEach([
			[
				"deleteSpace",
				() => xrpcPost(op(ctx), "com.atproto.space.deleteSpace", { space }),
				errorIs("NotSpaceOwner"),
			],
			[
				"updateSpace",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.updateSpace", {
						space,
						policy: personalspace(),
					}),
				errorIs("NotSpaceOwner"),
			],
			[
				"removeWriter",
				() =>
					xrpcPost(op(ctx), "com.atproto.space.removeWriter", { space, did }),
				errorIs("NotSpaceOwner"),
			],
			[
				"exportSpaceMeta",
				() => xrpcGet(op(ctx), "com.atproto.space.exportSpaceMeta", { space }),
				errorIs("NotSpaceOwner"),
			],
			[
				"putMember",
				() =>
					xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
						space,
						did,
						read: true,
						write: true,
					}),
				errorIs("NotSpaceOwner"),
			],
			[
				"removeMember",
				() =>
					xrpcPost(op(ctx), "com.atproto.memberspace.removeMember", {
						space,
						did,
					}),
				errorIs("NotSpaceOwner"),
			],
		]);
		return result.ok
			? pass("every management method answered NotSpaceOwner")
			: fail(`expected NotSpaceOwner: ${result.detail}`, result.evidence);
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
		L("com.atproto.memberspace.putMember@error:SpaceNotFound"),
		L("com.atproto.memberspace.removeMember@error:SpaceNotFound"),
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
					xrpcPost(op(ctx), "com.atproto.space.removeWriter", { space, did }),
				nf,
			],
			[
				"putMember",
				() =>
					xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
						space,
						did,
						read: true,
						write: false,
					}),
				nf,
			],
			[
				"removeMember",
				() =>
					xrpcPost(op(ctx), "com.atproto.memberspace.removeMember", {
						space,
						did,
					}),
				nf,
			],
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
	title: "deleteSpace is idempotent",
	tier: "must",
	citations: [L("com.atproto.space.deleteSpace")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, personalspace());
		const first = await xrpcPost(op(ctx), "com.atproto.space.deleteSpace", {
			space: space.uri,
		});
		const second = await xrpcPost(op(ctx), "com.atproto.space.deleteSpace", {
			space: space.uri,
		});
		return first.status === 200 && second.status === 200
			? pass("both deletes returned 200")
			: fail(`deletes returned ${describe(first)} then ${describe(second)}`, {
					first: first.json,
					second: second.json,
				});
	},
});

const spaceListSpaces = defineCheck({
	id: "space.listspaces-filters",
	title: "listSpaces lists the operator's spaces and honours spaceType and did",
	tier: "must",
	citations: [L("com.atproto.space.listSpaces")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, personalspace());
		try {
			// Filter on both: an OAuth grant scoped to the probe type under the
			// operator's authority covers exactly this listing.
			const seen: string[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 20; page++) {
				const res = await xrpcGet(op(ctx), "com.atproto.space.listSpaces", {
					spaceType: PROBE_TYPE,
					did: ctx.target.did,
					limit: "100",
					cursor,
				});
				if (res.status !== 200)
					return fail(`listSpaces ${describe(res)}`, res.json);
				const body = res.json as {
					spaces?: Array<{ uri: string }>;
					cursor?: string;
				};
				seen.push(...(body.spaces ?? []).map((s) => s.uri));
				cursor = body.cursor;
				if (!cursor || seen.includes(space.uri)) break;
			}
			if (!seen.includes(space.uri))
				return fail("listSpaces did not list the new space");
			const stray = seen.filter(
				(uri) => !uri.startsWith(`at://${ctx.target.did}/space/${PROBE_TYPE}/`),
			);
			return stray.length
				? fail(
						`filtered listing included spaces outside the filter: ${stray.join(", ")}`,
					)
				: pass(
						`listed the space; ${seen.length} result(s), all within the filter`,
					);
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
		// Each requires OAuth as the space owner: the policy and member list are
		// the authority's own state, and a credential — which any reader of a
		// public space can hold — must not expose them.
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

// --- memberspace ------------------------------------------------------

const memberRoundTrip = defineCheck({
	id: "memberspace.member-round-trip",
	title:
		"putMember sets per-member read/write; listMembers and removeMember follow",
	tier: "must",
	citations: [
		L("com.atproto.memberspace.putMember"),
		L("com.atproto.memberspace.listMembers"),
		L("com.atproto.memberspace.removeMember"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		const member = fakeDid();
		const list = async () => {
			const res = await xrpcGet(
				op(ctx),
				"com.atproto.memberspace.listMembers",
				{ space: space.uri },
			);
			if (res.status !== 200) throw new Error(`listMembers ${describe(res)}`);
			return (
				(
					res.json as {
						members?: Array<{ did: string; read: boolean; write: boolean }>;
					}
				).members ?? []
			).find((m) => m.did === member);
		};
		const put = (read: boolean, write: boolean) =>
			xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
				space: space.uri,
				did: member,
				read,
				write,
			});
		try {
			const first = await put(true, false);
			if (first.status !== 200)
				return fail(`putMember ${describe(first)}`, first.json);
			const a = await list();
			if (!a || a.read !== true || a.write !== false) {
				return fail(
					`after putMember(read, !write) listMembers shows ${JSON.stringify(a)}`,
				);
			}
			const second = await put(false, true);
			if (second.status !== 200)
				return fail(`putMember (replace) ${describe(second)}`, second.json);
			const b = await list();
			if (!b || b.read !== false || b.write !== true) {
				return fail(`putMember did not replace access: ${JSON.stringify(b)}`);
			}
			const removed = await xrpcPost(
				op(ctx),
				"com.atproto.memberspace.removeMember",
				{
					space: space.uri,
					did: member,
				},
			);
			if (removed.status !== 200)
				return fail(`removeMember ${describe(removed)}`, removed.json);
			const c = await list();
			return c
				? fail(`removeMember left ${JSON.stringify(c)}`)
				: pass("put, replaced and removed a member, as listMembers shows");
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
		L("com.atproto.memberspace.putMember@error:PolicyMismatch"),
		L("com.atproto.memberspace.removeMember@error:PolicyMismatch"),
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
					"putMember",
					() =>
						xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
							space: space.uri,
							did,
							read: true,
							write: true,
						}),
					mm,
				],
				[
					"removeMember",
					() =>
						xrpcPost(op(ctx), "com.atproto.memberspace.removeMember", {
							space: space.uri,
							did,
						}),
					mm,
				],
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
		C("baseline-space-policies"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx: CheckContext) {
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
			if (policy.status !== 200) {
				return fail(
					`no com.atproto.space.policy/self record: ${describe(policy)}`,
					policy.json,
				);
			}
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

			await xrpcPost(op(ctx), "com.atproto.memberspace.putMember", {
				space: space.uri,
				did: member,
				read: true,
				write: false,
			});
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
					`member record after putMember: ${describe(rec)}`,
					rec.json,
				);
			}

			await xrpcPost(op(ctx), "com.atproto.memberspace.removeMember", {
				space: space.uri,
				did: member,
			});
			const gone = await operatorGetRecord(
				ctx,
				space.uri,
				member,
				"com.atproto.memberspace.member",
			);
			return gone.status === 200
				? fail("the member record outlived removeMember", gone.json)
				: pass(
						"policy record published; member record tracked putMember and removeMember",
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
	spaceNotOwner,
	spaceUnknown,
	spaceDeleteIdempotent,
	spaceListSpaces,
	spaceOwnerStateNotByCredential,
	memberRoundTrip,
	memberPolicyMismatch,
	memberPublish,
];
