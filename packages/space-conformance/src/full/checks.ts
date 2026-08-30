/**
 * The crypto-bound check catalog: the checks that genuinely need the
 * alpha libs or harness-held foreign identities, and nothing else — every
 * check an operator session can run with plain fetch + WebCrypto lives in
 * `../checks/operator.js` instead, browser included.
 *
 * What keeps a check here:
 * - `identities`: the harness plays a reader/member who is not the
 *   operator, minting delegation tokens the target must verify by
 *   resolving the reader's DID — only an in-process fixture with an
 *   injected resolver can arrange that.
 * - `LtHash`: folding the oplog needs the lattice set-hash from
 *   `@atproto/space`, whose bundle pulls node-only dependencies.
 */

import { LtHash } from "@atproto/space";
import { fromBase64 } from "@atproto/lex-data";
import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost } from "../http.js";
import { fail, pass, type Check } from "../model.js";
import {
	createProbeSpace,
	credentialGet,
	deleteProbeSpace,
	obtainCredential,
	operatorCreateRecord,
} from "./helpers.js";
import { POST, note } from "../checks/operator.js";

// --- credential / delegation (foreign identities) ----------------------

const credentialRoundTrip = defineCheck({
	id: "credential.round-trip",
	title: "A member exchanges a delegation token for a credential and reads",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.getSpaceCredential" },
		{ source: "lexicon", ref: "com.atproto.space.getRecord" },
	],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx);
		try {
			await operatorCreateRecord(
				ctx,
				space.uri,
				POST,
				"shared",
				note("visible"),
			);
			// member-list policy: authorize the reader first.
			await xrpcPost(asOperator(ctx), "com.atproto.simplespace.addMember", {
				space: space.uri,
				did: reader.did,
			});
			const { result, credential } = await obtainCredential(
				ctx,
				reader,
				space.uri,
			);
			if (!credential) {
				return fail(
					`getSpaceCredential ${result.status} ${result.error ?? ""}`,
					result.json,
				);
			}
			const read = await credentialGet(
				ctx,
				credential,
				"com.atproto.space.getRecord",
				{
					space: space.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey: "shared",
				},
			);
			return read.status === 200
				? pass("credential read the space")
				: fail(
						`credential read failed: ${read.status} ${read.error ?? ""}`,
						read.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialCrossSpace = defineCheck({
	id: "credential.cross-space-refused",
	title: "A credential for one space cannot read another",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.getRecord" }],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const publicPolicy = {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		};
		const spaceA = await createProbeSpace(ctx, publicPolicy);
		const spaceB = await createProbeSpace(ctx, publicPolicy);
		try {
			await operatorCreateRecord(ctx, spaceB.uri, POST, "secret", note("b"));
			const { credential } = await obtainCredential(ctx, reader, spaceA.uri);
			if (!credential) return fail("could not obtain a credential for space A");
			const cross = await credentialGet(
				ctx,
				credential,
				"com.atproto.space.getRecord",
				{
					space: spaceB.uri,
					repo: ctx.target.did,
					collection: POST,
					rkey: "secret",
				},
			);
			return cross.status === 200
				? fail("space-A credential read space B", cross.json)
				: pass(
						`cross-space read refused with ${cross.status} ${cross.error ?? ""}`,
					);
		} finally {
			await deleteProbeSpace(ctx, spaceA.uri);
			await deleteProbeSpace(ctx, spaceB.uri);
		}
	},
});

const delegationReplay = defineCheck({
	id: "delegation.replay-refused",
	title: "A delegation token cannot be used twice",
	tier: "must",
	citations: [
		{
			source: "lexicon",
			ref: "com.atproto.space.getSpaceCredential@error:InvalidDelegationToken",
		},
	],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx, {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		try {
			// Reuse one delegation token twice by minting it once. obtainCredential
			// mints a fresh token each call, so drive the exchange directly.
			const { createDpopProof, createSpaceToken, spaceHostAud } =
				await import("@atproto/space");
			const delegation = await createSpaceToken(
				"delegation",
				{
					iss: reader.did,
					sub: space.uri,
					aud: spaceHostAud(ctx.target.did),
				},
				{
					jwtAlg: reader.jwtAlg,
					sign: (b: Uint8Array) => reader.sign(b),
				} as never,
			);
			const exchange = async () => {
				const dpopKey = await ctx.identities!.dpopKey();
				const proof = await createDpopProof(dpopKey as never, {
					htm: "POST",
					htu: `${ctx.target.origin}/xrpc/com.atproto.space.getSpaceCredential`,
				});
				return xrpcPost(
					ctx,
					"com.atproto.space.getSpaceCredential",
					{ space: space.uri },
					{ Authorization: `Bearer ${delegation}`, DPoP: proof },
				);
			};
			const first = await exchange();
			if (first.status !== 200) {
				return fail(
					`first exchange failed (${first.status}); cannot test replay`,
					first.json,
				);
			}
			const second = await exchange();
			return second.status === 200
				? fail("a replayed delegation token was accepted")
				: pass(`replay refused with ${second.status} ${second.error ?? ""}`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const delegationWrongAud = defineCheck({
	id: "delegation.wrong-audience-refused",
	title: "A delegation token addressed to another host is refused",
	tier: "must",
	citations: [
		{
			source: "lexicon",
			ref: "com.atproto.space.getSpaceCredential@error:InvalidDelegationToken",
		},
	],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx, {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		try {
			// Positive control: with the correct audience the same reader is
			// admitted (public policy), so a refusal below is attributable to
			// the audience and not to, say, an unresolvable reader DID.
			const control = await obtainCredential(ctx, reader, space.uri);
			if (!control.credential) {
				return fail(
					`correct-aud control failed (${control.result.status} ${control.result.error ?? ""}); cannot attribute the wrong-aud refusal`,
					control.result.json,
				);
			}
			const { result } = await obtainCredential(ctx, reader, space.uri, {
				audOverride: "did:web:someone-else.example#atproto_space_host",
			});
			if (result.status === 200) {
				return fail("a token with the wrong audience was accepted");
			}
			return result.error === "InvalidDelegationToken"
				? pass("wrong-aud token refused with InvalidDelegationToken")
				: pass(
						`wrong-aud token refused (${result.status} ${result.error ?? ""}); InvalidDelegationToken preferred`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- sync --------------------------------------------------------------

const syncOplogFolds = defineCheck({
	id: "sync.oplog-folds-to-commit",
	// "set-hash", not "signed": this check verifies the host's ops fold to the
	// commit hash the host serves — an internal-consistency property (catching
	// oplog/commit divergence, e.g. compaction bugs). It does not verify the
	// commit *signature*; no check does yet, and claiming so would overstate.
	title: "Folding the oplog reproduces the commit set-hash",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.listRepoOps" },
		{ source: "lexicon", ref: "com.atproto.space.defs" },
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx);
		try {
			await operatorCreateRecord(ctx, space.uri, POST, "a", note("1"));
			await operatorCreateRecord(ctx, space.uri, POST, "b", note("2"));
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.listRepoOps",
				{ space: space.uri, repo: ctx.target.did },
			);
			if (res.status !== 200) {
				return fail(`listRepoOps ${res.status} ${res.error ?? ""}`, res.json);
			}
			const body = res.json as {
				ops: Array<{
					collection: string;
					rkey: string;
					cid: string | null;
					prev: string | null;
				}>;
				commit?: { hash: { $bytes: string } };
			};
			if (!body.commit) {
				return fail("listRepoOps reached the head but returned no commit");
			}
			const setHash = new LtHash();
			for (const op of body.ops) {
				if (op.prev) setHash.remove(`${op.collection}/${op.rkey}/${op.prev}`);
				if (op.cid) setHash.add(`${op.collection}/${op.rkey}/${op.cid}`);
			}
			const folded = setHash.digest();
			const claimed = fromBase64(body.commit.hash.$bytes);
			const equal =
				folded.length === claimed.length &&
				folded.every((byte, i) => byte === claimed[i]);
			return equal
				? pass("folded oplog matches the commit hash")
				: fail("folded oplog does not match the commit hash");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- host role ---------------------------------------------------------

const hostMemberGate = defineCheck({
	id: "host.member-list-gates",
	title: "member-list policy refuses a non-member and admits a member",
	tier: "must",
	citations: [
		{
			source: "lexicon",
			ref: "com.atproto.space.getSpaceCredential@error:UserNotAuthorized",
		},
		{ source: "lexicon", ref: "com.atproto.simplespace.addMember" },
	],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx);
		try {
			const before = await obtainCredential(ctx, reader, space.uri);
			if (before.credential) {
				return fail(
					"a non-member obtained a credential under member-list policy",
				);
			}
			await xrpcPost(asOperator(ctx), "com.atproto.simplespace.addMember", {
				space: space.uri,
				did: reader.did,
			});
			const after = await obtainCredential(ctx, reader, space.uri);
			return after.credential
				? pass(
						`non-member refused (${before.result.error ?? before.result.status}), member admitted`,
					)
				: fail(
						`a member was refused: ${after.result.status} ${after.result.error ?? ""}`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const hostDeleteTombstone = defineCheck({
	id: "host.delete-space-tombstone",
	title: "After deleteSpace, getSpaceCredential answers SpaceDeleted",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.simplespace.deleteSpace" },
		{
			source: "lexicon",
			ref: "com.atproto.space.getSpaceCredential@error:SpaceDeleted",
		},
	],
	needs: ["operator", "identities"],
	destructive: true,
	async run(ctx) {
		const reader = await ctx.identities!.identity("reader");
		const space = await createProbeSpace(ctx, {
			$type: "com.atproto.simplespace.defs#publicPolicy",
		});
		// Positive control: before deletion the reader can obtain a
		// credential. Without it, a target that simply can't resolve the
		// reader (so credentials always fail) would pass the tombstone check
		// without the deletion ever being exercised.
		const before = await obtainCredential(ctx, reader, space.uri);
		if (!before.credential) {
			await deleteProbeSpace(ctx, space.uri);
			return fail(
				`could not obtain a credential before deletion (${before.result.status} ${before.result.error ?? ""}); cannot test the tombstone`,
				before.result.json,
			);
		}
		const del = await xrpcPost(
			asOperator(ctx),
			"com.atproto.simplespace.deleteSpace",
			{ space: space.uri },
		);
		if (del.status !== 200) {
			return fail(
				`deleteSpace failed (${del.status} ${del.error ?? ""})`,
				del.json,
			);
		}
		const { result } = await obtainCredential(ctx, reader, space.uri);
		if (result.status === 200)
			return fail("a deleted space still issued a credential");
		// The proposal specifies SpaceDeleted as the durable tombstone signal
		// so a syncer that missed the notification learns to drop its copy.
		return result.error === "SpaceDeleted"
			? pass("getSpaceCredential answered SpaceDeleted")
			: fail(
					`deleted space refused with ${result.error} (${result.status}), expected SpaceDeleted`,
					result.json,
				);
	},
});

/** The crypto-bound catalog: identity checks plus the LtHash fold. */
export const cryptoChecks: Check[] = [
	credentialRoundTrip,
	credentialCrossSpace,
	delegationReplay,
	delegationWrongAud,
	syncOplogFolds,
	hostMemberGate,
	hostDeleteTombstone,
];
