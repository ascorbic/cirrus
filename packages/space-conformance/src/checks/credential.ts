/**
 * Space credentials, operator-side: issuance through authorizeSpaceSync
 * (tokenless for public-read spaces, via the target's own delegation
 * tokens otherwise), the refusals it declares, and presentation — the
 * HTTP message signature, the audience binding and the MAC request every
 * credentialed read of a commit or record must carry.
 *
 * All browser-safe: credential keys, signatures and HPKE key shares are
 * WebCrypto (see ../space-auth.ts). Verifying the MACs that come back
 * needs the reference library and lives in ../full/checks.ts.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet, xrpcPost } from "../http.js";
import { fail, pass, type Check, type CheckContext } from "../model.js";
import { decodeJwt, isTid, rawCid, toBase64Url, utf8 } from "../encoding.js";
import {
	COMMIT_MAC_PROFILE,
	RECORD_MAC_PROFILE,
	createCredentialKey,
	credentialSigMembers,
	formatDidKey,
	formatMacRequest,
} from "../space-auth.js";
import {
	FOREIGN_DID,
	POST,
	createProbeSpace,
	credentialCall,
	credentialGet,
	deleteProbeSpace,
	describe,
	errorIs,
	memberspace,
	mustCreateRecord,
	obtainCredentialViaDelegation,
	obtainPublicCredential,
	personalspace,
	publicRead,
	requestCredential,
	type Credential,
	type CredentialCallOptions,
	type ProbeSpace,
} from "./probe.js";
import { fakeDid } from "./space.js";

const L = (ref: string) => ({ source: "lexicon" as const, ref });
const P = (ref: string) => ({ source: "proposal" as const, ref });

/** Refusals the lexicon allows for an account the policy does not authorise. */
export const ACCOUNT_REFUSALS = [
	"SpaceNotFound",
	"AccountNotAuthorized",
	"NotAuthorized",
];

/** A public-read probe space holding one record, plus a tokenless credential for it. */
async function withPublicSpace<T>(
	ctx: CheckContext,
	fn: (space: ProbeSpace, credential: Credential) => Promise<T>,
): Promise<T> {
	const space = await createProbeSpace(ctx, publicRead());
	try {
		await mustCreateRecord(ctx, space.uri, "shared", "visible");
		const credential = await obtainPublicCredential(ctx, space.uri);
		return await fn(space, credential);
	} finally {
		await deleteProbeSpace(ctx, space.uri);
	}
}

const recordParams = (ctx: CheckContext, space: string) => ({
	space,
	repo: ctx.target.did,
	collection: POST,
	rkey: "shared",
});

/** Read the shared record with a credential, varying one aspect of presentation. */
const readShared = (
	ctx: CheckContext,
	credential: Credential,
	space: string,
	opts: Omit<CredentialCallOptions, "params"> = {},
) =>
	credentialCall(ctx, credential, "com.atproto.space.getRecord", {
		...opts,
		params: recordParams(ctx, space),
	});

const refused = (status: number) => status >= 400 && status < 500;

// --- issuance ----------------------------------------------------------

const credentialTokenlessPolicies = defineCheck({
	id: "credential.tokenless-by-policy",
	title:
		"Without a delegation token only a public-read space issues a credential",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync"),
		L("com.atproto.space.authorizeSpaceSync@error:SpaceNotFound"),
		L("com.atproto.memberspace.policy"),
		L("com.atproto.personalspace.policy"),
		P("0016#memberspace"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const open = await createProbeSpace(ctx, publicRead());
		const closed = await createProbeSpace(ctx, memberspace());
		const personal = await createProbeSpace(ctx, personalspace());
		try {
			const a = await requestCredential(ctx, open.uri);
			if (!a.credential)
				return fail(
					`public-read space refused a tokenless request: ${describe(a.result)}`,
					a.result.json,
				);
			const misses: string[] = [];
			for (const [label, space] of [
				["memberspace", closed],
				["personalspace", personal],
			] as const) {
				const res = await requestCredential(ctx, space.uri);
				if (res.credential || !errorIs(...ACCOUNT_REFUSALS)(res.result))
					misses.push(`${label} → ${describe(res.result)}`);
			}
			return misses.length
				? fail(`expected ${ACCOUNT_REFUSALS.join(" / ")}: ${misses.join("; ")}`)
				: pass(
						"public-read issued; a closed memberspace and a personalspace refused",
					);
		} finally {
			for (const s of [open, closed, personal])
				await deleteProbeSpace(ctx, s.uri);
		}
	},
});

const credentialClaims = defineCheck({
	id: "credential.claims",
	title:
		"A credential is signed by the authority for the space, bound to the requested key",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync"),
		P("0016#space-credential"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const credential = await obtainPublicCredential(ctx, space.uri);
			const { header, payload } = decodeJwt(credential.credential);
			const cnf = payload.cnf as { kid?: unknown } | undefined;
			const problems: string[] = [];
			if (header.typ !== "atproto-space-credential+jwt")
				problems.push(`typ ${String(header.typ)}`);
			if (header.kid !== "#atproto") problems.push(`kid ${String(header.kid)}`);
			if (payload.iss !== ctx.target.did)
				problems.push(`iss ${String(payload.iss)}`);
			if (payload.sub !== space.uri)
				problems.push(`sub ${String(payload.sub)}`);
			if (cnf?.kid !== credential.key.did)
				problems.push(`cnf.kid ${String(cnf?.kid)}`);
			// Credentials carry no audience: each use is bound to one by its signature.
			if ("aud" in payload) problems.push(`has aud ${String(payload.aud)}`);
			if (typeof payload.jti !== "string" || !payload.jti)
				problems.push("no jti");
			const iat = Number(payload.iat);
			const exp = Number(payload.exp);
			if (!(exp > iat) || exp - iat > 3600)
				problems.push(`lifetime ${exp - iat}s (max 3600)`);
			return problems.length
				? fail(`credential claims: ${problems.join(", ")}`, { header, payload })
				: pass(`typ/kid/iss/sub/cnf correct, no aud, ${exp - iat}s lifetime`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialDefaultLifetime = defineCheck({
	id: "credential.default-lifetime",
	title: "Credentials live 600 seconds, the default",
	tier: "should",
	citations: [P("0016#space-credential")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const { payload } = decodeJwt(
				(await obtainPublicCredential(ctx, space.uri)).credential,
			);
			const lifetime = Number(payload.exp) - Number(payload.iat);
			return lifetime === 600 ? pass("600s") : fail(`${lifetime}s`);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialSpaceRev = defineCheck({
	id: "credential.space-rev",
	title:
		"authorizeSpaceSync reports the space's current revision, omitted before its first update",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync"),
		P("0016#authorizing-space-sync"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const fresh = await requestCredential(ctx, space.uri);
			if (!fresh.credential)
				return fail(
					`authorizeSpaceSync ${describe(fresh.result)}`,
					fresh.result.json,
				);
			if (fresh.spaceRev !== undefined)
				return fail(
					`a space with no updates reported spaceRev ${fresh.spaceRev}`,
				);
			await mustCreateRecord(ctx, space.uri, "a");
			const after = await requestCredential(ctx, space.uri);
			if (!isTid(after.spaceRev))
				return fail(
					`after a write, spaceRev is ${String(after.spaceRev)}`,
					after.result.json,
				);
			// The space's current revision is the latest one listWriters sequenced.
			const list = await credentialCall(
				ctx,
				after.credential!,
				"com.atproto.space.listWriters",
				{
					params: { space: space.uri },
					audience: ctx.target.did,
				},
			);
			const revs = (
				(list.json as { repos?: Array<{ spaceRev?: string }> } | undefined)
					?.repos ?? []
			).map((r) => r.spaceRev);
			return revs.at(-1) === after.spaceRev
				? pass(
						`omitted before the first update; then ${after.spaceRev}, the latest sequenced revision`,
					)
				: fail(
						`spaceRev ${after.spaceRev} is not the latest listWriters revision ${revs.at(-1)}`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialKeyP256 = defineCheck({
	id: "credential.key-must-be-p256",
	title:
		"authorizeSpaceSync refuses a credentialKey that is not a P-256 did:key",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync"),
		P("0016#credential-key-binding"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			// A well-formed secp256k1 did:key: valid syntax, wrong curve.
			const k256 = formatDidKey(
				"ES256K",
				new Uint8Array([0x02, ...crypto.getRandomValues(new Uint8Array(32))]),
			);
			const bad = await requestCredential(ctx, space.uri, {
				credentialKey: k256,
			});
			if (bad.credential)
				return fail("issued a credential bound to a secp256k1 key");
			const notKey = await requestCredential(ctx, space.uri, {
				credentialKey: ctx.target.did,
			});
			if (notKey.credential)
				return fail("issued a credential bound to a non-key DID");
			const good = await requestCredential(ctx, space.uri);
			return good.credential
				? pass(
						`refused secp256k1 (${describe(bad.result)}) and non-key (${describe(notKey.result)}); P-256 issued`,
					)
				: fail(
						`positive control failed: ${describe(good.result)}`,
						good.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialGarbageDelegation = defineCheck({
	id: "credential.garbage-delegation-refused",
	title: "A malformed delegation token is refused with InvalidDelegationToken",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync@error:InvalidDelegationToken"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		try {
			const res = await requestCredential(ctx, space.uri, {
				delegationToken: "not.a.token",
			});
			if (res.credential)
				return fail("issued a credential for a garbage delegation token");
			return res.result.error === "InvalidDelegationToken"
				? pass("refused with InvalidDelegationToken")
				: fail(
						`refused with ${describe(res.result)}, expected InvalidDelegationToken`,
						res.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

/**
 * A structurally valid client attestation for a client nobody can resolve:
 * typed, addressed to the space host, iss = sub = an unresolvable
 * client_id, signed by a throwaway key. Only verification can refuse it.
 */
async function unverifiableAttestation(authority: string): Promise<string> {
	const clientId = "https://app.space-conformance.invalid/client-metadata.json";
	const key = await createCredentialKey();
	const iat = Math.floor(Date.now() / 1000);
	const part = (obj: unknown) => toBase64Url(utf8(JSON.stringify(obj)));
	const input = `${part({ alg: "ES256", typ: "atproto-client-attestation+jwt", kid: "key-1" })}.${part(
		{
			iss: clientId,
			sub: clientId,
			aud: `${authority}#atproto_pds`,
			iat,
			exp: iat + 60,
			jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		},
	)}`;
	return `${input}.${toBase64Url(await key.sign(utf8(input)))}`;
}

const attestationCitations = [
	L("com.atproto.space.authorizeSpaceSync@error:InvalidClientAttestation"),
	P("0016#client-attestation"),
];

const credentialUnverifiableAttestation = defineCheck({
	id: "credential.unverifiable-attestation-refused",
	title:
		"A client attestation that cannot be verified is refused with InvalidClientAttestation",
	tier: "must",
	citations: attestationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// A public-read space would issue without it, so the refusal can only
		// be the attestation's.
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const res = await requestCredential(ctx, space.uri, {
				clientAttestation: await unverifiableAttestation(ctx.target.did),
			});
			if (res.credential)
				return fail(
					"issued a credential on an unverifiable client attestation",
				);
			return res.result.error === "InvalidClientAttestation"
				? pass("refused with InvalidClientAttestation")
				: fail(
						`refused with ${describe(res.result)}, expected InvalidClientAttestation`,
						res.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialGarbageAttestation = defineCheck({
	id: "credential.garbage-attestation-refused",
	title:
		"A malformed client attestation is refused with InvalidClientAttestation",
	tier: "must",
	citations: attestationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const res = await requestCredential(ctx, space.uri, {
				clientAttestation: "not.an.attestation",
			});
			if (res.credential)
				return fail("issued a credential despite a garbage client attestation");
			return res.result.error === "InvalidClientAttestation"
				? pass("refused with InvalidClientAttestation")
				: fail(
						`refused with ${describe(res.result)}, expected InvalidClientAttestation`,
						res.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialAllowedApps = defineCheck({
	id: "credential.allowed-apps-gate",
	title: "A memberspace with allowedApps refuses an unattested app",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync@error:AppNotAuthorized"),
		L("com.atproto.memberspace.policy"),
		P("0016#memberspace"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// publicRead clears the account perimeter, so only the app perimeter is
		// left to refuse; NotAuthorized may stand in for AppNotAuthorized.
		const space = await createProbeSpace(
			ctx,
			memberspace({
				publicRead: true,
				allowedApps: [
					"https://app.space-conformance.invalid/client-metadata.json",
				],
			}),
		);
		try {
			const res = await requestCredential(ctx, space.uri);
			if (res.credential)
				return fail("issued a credential to an app outside allowedApps");
			return errorIs("AppNotAuthorized", "NotAuthorized")(res.result)
				? pass(`refused with ${res.result.error}`)
				: fail(
						`refused with ${describe(res.result)}, expected AppNotAuthorized`,
						res.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const credentialDeletedSpace = defineCheck({
	id: "credential.deleted-space",
	title:
		"deleteSpace removes the authority's repo, and authorizeSpaceSync then answers SpaceDeleted",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteSpace"),
		L("com.atproto.space.authorizeSpaceSync@error:SpaceDeleted"),
		P("0016#space-deletion"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		await mustCreateRecord(ctx, space.uri, "mine");
		const before = await requestCredential(ctx, space.uri);
		if (!before.credential) {
			await deleteProbeSpace(ctx, space.uri);
			return fail(
				`could not obtain a credential before deletion (${describe(before.result)})`,
			);
		}
		const del = await xrpcPost(
			asOperator(ctx),
			"com.atproto.space.deleteSpace",
			{ space: space.uri },
		);
		if (del.status !== 200)
			return fail(`deleteSpace ${describe(del)}`, del.json);
		// "Delete a space, along with the authority's space repo."
		const own = await xrpcGet(asOperator(ctx), "com.atproto.space.getRecord", {
			space: space.uri,
			repo: ctx.target.did,
			collection: POST,
			rkey: "mine",
		});
		if (own.status === 200)
			return fail("the authority's own record survived deleteSpace", own.json);
		// "regardless of the request's authorization": tokenless, and with a
		// garbage delegation token.
		const tokenless = await requestCredential(ctx, space.uri);
		const garbage = await requestCredential(ctx, space.uri, {
			delegationToken: "not.a.token",
		});
		if (tokenless.credential)
			return fail("a deleted space still issued a credential");
		return tokenless.result.error === "SpaceDeleted" &&
			garbage.result.error === "SpaceDeleted"
			? pass(
					"own records gone; answered SpaceDeleted, tokenless and with a bad token",
				)
			: fail(
					`answered ${describe(tokenless.result)} tokenless, ${describe(garbage.result)} with a bad token; expected SpaceDeleted`,
				);
	},
});

const credentialUnconfirmedRegistration = defineCheck({
	id: "credential.unconfirmed-registration-refused",
	title:
		"A notify endpoint that does not confirm the registration gets RegistrationNotConfirmed",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync@error:RegistrationNotConfirmed"),
		P("0016#registering-for-notifications"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// An endpoint nobody serves can't echo the challenge.
		const space = await createProbeSpace(ctx, publicRead());
		try {
			const res = await requestCredential(ctx, space.uri, {
				notify: {
					endpoint: "https://syncer.space-conformance.invalid",
					token: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
				},
			});
			if (res.credential)
				return fail("issued a credential with an unconfirmed registration");
			return res.result.error === "RegistrationNotConfirmed"
				? pass("refused with RegistrationNotConfirmed")
				: fail(
						`refused with ${describe(res.result)}, expected RegistrationNotConfirmed`,
						res.result.json,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

// --- delegation (the target's own tokens) --------------------------------

const credentialSelfRoundTrip = defineCheck({
	id: "credential.self-round-trip",
	title:
		"Operator obtains a credential via getDelegationToken and reads with it",
	tier: "must",
	citations: [
		L("com.atproto.space.getDelegationToken"),
		L("com.atproto.space.authorizeSpaceSync"),
		L("com.atproto.space.getRecord"),
		P("0016#credential-flow"),
	],
	needs: ["operator", "pds-delegation"],
	destructive: true,
	async run(ctx) {
		// A closed memberspace: only the delegation token can get the operator in.
		const space = await createProbeSpace(ctx, memberspace());
		try {
			await mustCreateRecord(ctx, space.uri, "shared", "mine");
			const { result, credential, delegation } =
				await obtainCredentialViaDelegation(ctx, space.uri);
			if (delegation.status !== 200)
				return fail(
					`getDelegationToken ${describe(delegation)}`,
					delegation.json,
				);
			if (!credential)
				return fail(`authorizeSpaceSync ${describe(result)}`, result.json);
			const read = await readShared(ctx, credential, space.uri);
			if (read.status !== 200)
				return fail(`credential read failed: ${describe(read)}`, read.json);
			return read.headers.get("atproto-space-record") &&
				read.headers.get("signature")
				? pass("delegation → credential → MAC'd read works")
				: fail("the credentialed read carried no Atproto-Space-Record MAC");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const delegationClaims = defineCheck({
	id: "delegation.token-claims",
	title:
		"getDelegationToken mints a token for the space's #atproto_pds, signed by #atproto",
	tier: "must",
	citations: [
		L("com.atproto.space.getDelegationToken"),
		P("0016#delegation-token"),
	],
	needs: ["operator", "pds-delegation"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		try {
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getDelegationToken",
				{ space: space.uri },
			);
			if (res.status !== 200)
				return fail(`getDelegationToken ${describe(res)}`, res.json);
			const { header, payload } = decodeJwt(
				(res.json as { token: string }).token,
			);
			const problems: string[] = [];
			if (header.typ !== "atproto-space-delegation+jwt")
				problems.push(`typ ${String(header.typ)}`);
			if (header.kid !== "#atproto") problems.push(`kid ${String(header.kid)}`);
			if (payload.iss !== ctx.target.did)
				problems.push(`iss ${String(payload.iss)}`);
			if (payload.sub !== space.uri)
				problems.push(`sub ${String(payload.sub)}`);
			if (payload.aud !== `${ctx.target.did}#atproto_pds`)
				problems.push(`aud ${String(payload.aud)}`);
			if ("lxm" in payload) problems.push("has an lxm claim");
			if (typeof payload.jti !== "string" || !payload.jti)
				problems.push("no jti");
			if (!(Number(payload.exp) > Math.floor(Date.now() / 1000) - 5))
				problems.push("already expired");
			return problems.length
				? fail(`delegation token: ${problems.join(", ")}`, { header, payload })
				: pass("typ/kid/iss/sub/aud as specified, no lxm");
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const delegationReplay = defineCheck({
	id: "delegation.replay-refused",
	title: "A delegation token cannot be used twice",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync@error:InvalidDelegationToken"),
		P("0016#delegation-token"),
	],
	needs: ["operator", "pds-delegation"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, memberspace());
		try {
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getDelegationToken",
				{ space: space.uri },
			);
			if (res.status !== 200)
				return fail(`getDelegationToken ${describe(res)}`, res.json);
			const delegationToken = (res.json as { token: string }).token;
			const first = await requestCredential(ctx, space.uri, {
				delegationToken,
			});
			if (!first.credential)
				return fail(
					`first exchange failed (${describe(first.result)}); cannot test replay`,
				);
			const second = await requestCredential(ctx, space.uri, {
				delegationToken,
			});
			if (second.credential)
				return fail("a replayed delegation token was accepted");
			return second.result.error === "InvalidDelegationToken"
				? pass("replay refused with InvalidDelegationToken")
				: fail(
						`replay refused with ${describe(second.result)}, expected InvalidDelegationToken`,
					);
		} finally {
			await deleteProbeSpace(ctx, space.uri);
		}
	},
});

const delegationWrongSpace = defineCheck({
	id: "delegation.wrong-space-refused",
	title: "A delegation token for one space is refused for another",
	tier: "must",
	citations: [
		L("com.atproto.space.authorizeSpaceSync@error:InvalidDelegationToken"),
		P("0016#delegation-token"),
	],
	needs: ["operator", "pds-delegation"],
	destructive: true,
	async run(ctx) {
		const a = await createProbeSpace(ctx, memberspace());
		const b = await createProbeSpace(ctx, memberspace());
		try {
			const res = await xrpcGet(
				asOperator(ctx),
				"com.atproto.space.getDelegationToken",
				{ space: a.uri },
			);
			if (res.status !== 200)
				return fail(`getDelegationToken ${describe(res)}`, res.json);
			const cross = await requestCredential(ctx, b.uri, {
				delegationToken: (res.json as { token: string }).token,
			});
			if (cross.credential)
				return fail("a token for space A issued a credential for space B");
			return cross.result.error === "InvalidDelegationToken"
				? pass("refused with InvalidDelegationToken")
				: fail(
						`refused with ${describe(cross.result)}, expected InvalidDelegationToken`,
					);
		} finally {
			await deleteProbeSpace(ctx, a.uri);
			await deleteProbeSpace(ctx, b.uri);
		}
	},
});

// --- presentation -----------------------------------------------------

const presentationCitations = [
	L("com.atproto.space.getRecord"),
	L("com.atproto.space.listWriters"),
	P("0016#presenting-a-space-credential"),
];

const credentialSignatureRequired = defineCheck({
	id: "credential.signature-required",
	title: "A credential presented without its HTTP signature is refused",
	tier: "must",
	citations: presentationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const ok = await readShared(ctx, credential, space.uri);
			if (ok.status !== 200)
				return fail(`positive control failed: ${describe(ok)}`, ok.json);
			const bare = await readShared(ctx, credential, space.uri, {
				unsigned: true,
			});
			return refused(bare.status)
				? pass(`signed read 200; unsigned read refused (${describe(bare)})`)
				: fail(
						`an unsigned credential read returned ${describe(bare)}`,
						bare.json,
					);
		});
	},
});

const credentialSignatureByTag = defineCheck({
	id: "credential.signature-found-by-tag",
	title:
		"The credential signature is found by its tag under any label; other parameters are ignored",
	tier: "must",
	citations: presentationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const now = Math.floor(Date.now() / 1000);
			const variants: Array<[string, CredentialCallOptions["signature"]]> = [
				["label 'x7'", { label: "x7" }],
				[
					"created and nonce parameters",
					{
						params: [
							["created", now],
							["nonce", "abc"],
						],
					},
				],
				[
					"keyid = cnf.kid and alg = ecdsa-p256-sha256",
					{
						params: [
							["keyid", credential.key.did],
							["alg", "ecdsa-p256-sha256"],
						],
					},
				],
			];
			const misses: string[] = [];
			for (const [label, signature] of variants) {
				const res = await readShared(ctx, credential, space.uri, { signature });
				if (res.status !== 200) misses.push(`${label} → ${describe(res)}`);
			}
			// A second, unrelated signature with another tag alongside is ignored.
			const extra = await readShared(ctx, credential, space.uri, {
				signatureHeaders: async (h) => {
					const other = await credentialSigMembers(credential.key, {
						authorization: h.authorization!,
						audience: h["atproto-space-audience"]!,
						label: "other",
						tag: "some-other-app",
					});
					return {
						...h,
						"signature-input": `${h["signature-input"]}, ${other.input}`,
						signature: `${h.signature}, ${other.signature}`,
					};
				},
			});
			if (extra.status !== 200)
				misses.push(
					`with an extra differently-tagged signature → ${describe(extra)}`,
				);
			return misses.length
				? fail(`refused a valid signature: ${misses.join("; ")}`)
				: pass(
						"accepted under another label, with extra parameters, and beside another tag's signature",
					);
		});
	},
});

const credentialSignatureRequirements = defineCheck({
	id: "credential.signature-requirements",
	title:
		"A credential signature with the wrong components, keyid, alg or count is refused",
	tier: "must",
	citations: presentationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const ok = await readShared(ctx, credential, space.uri);
			if (ok.status !== 200)
				return fail(`positive control failed: ${describe(ok)}`, ok.json);
			const other = await createCredentialKey();
			const variants: Array<[string, Omit<CredentialCallOptions, "params">]> = [
				[
					"covers only authorization",
					{ signature: { components: ["authorization"] } },
				],
				[
					"components out of order",
					{
						signature: {
							components: ["atproto-space-audience", "authorization"],
						},
					},
				],
				[
					"keyid of another key",
					{ signature: { params: [["keyid", other.did]] } },
				],
				[
					"alg hmac-sha256",
					{ signature: { params: [["alg", "hmac-sha256"]] } },
				],
				[
					"no atproto-space-credential tag",
					{ signature: { tag: "something-else" } },
				],
				[
					"two tagged signatures",
					{
						signatureHeaders: async (h) => {
							const dup = await credentialSigMembers(credential.key, {
								authorization: h.authorization!,
								audience: h["atproto-space-audience"]!,
								label: "dup",
							});
							return {
								...h,
								"signature-input": `${h["signature-input"]}, ${dup.input}`,
								signature: `${h.signature}, ${dup.signature}`,
							};
						},
					},
				],
			];
			const misses: string[] = [];
			for (const [label, opts] of variants) {
				const res = await readShared(ctx, credential, space.uri, opts);
				if (!refused(res.status)) misses.push(`${label} → ${describe(res)}`);
			}
			return misses.length
				? fail(`accepted: ${misses.join("; ")}`)
				: pass("every malformed signature was refused");
		});
	},
});

const credentialAudienceBound = defineCheck({
	id: "credential.audience-bound",
	title: "A credential signed for another audience is refused",
	tier: "must",
	citations: presentationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const ok = await readShared(ctx, credential, space.uri);
			if (ok.status !== 200)
				return fail(`positive control failed: ${describe(ok)}`, ok.json);
			const misaddressed = await readShared(ctx, credential, space.uri, {
				audience: FOREIGN_DID,
			});
			if (!refused(misaddressed.status))
				return fail(
					`a misaddressed repo-host read returned ${describe(misaddressed)}`,
					misaddressed.json,
				);
			// The same at the space host, whose audience is the authority.
			const listWriters = (audience: string) =>
				credentialCall(ctx, credential, "com.atproto.space.listWriters", {
					params: { space: space.uri },
					audience,
				});
			const hostOk = await listWriters(ctx.target.did);
			if (hostOk.status !== 200)
				return fail(
					`listWriters positive control failed: ${describe(hostOk)}`,
					hostOk.json,
				);
			const hostWrong = await listWriters(FOREIGN_DID);
			return refused(hostWrong.status)
				? pass(
						`refused other audiences at the repo host (${describe(misaddressed)}) and space host (${describe(hostWrong)})`,
					)
				: fail(
						`a misaddressed listWriters returned ${describe(hostWrong)}`,
						hostWrong.json,
					);
		});
	},
});

const credentialWrongKey = defineCheck({
	id: "credential.wrong-key-refused",
	title: "A credential signed by a key other than its cnf.kid is refused",
	tier: "must",
	citations: presentationCitations,
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const ok = await readShared(ctx, credential, space.uri);
			if (ok.status !== 200)
				return fail(`positive control failed: ${describe(ok)}`, ok.json);
			const thief = await readShared(ctx, credential, space.uri, {
				signWith: await createCredentialKey(),
			});
			return refused(thief.status)
				? pass(`refused a signature by the wrong key (${describe(thief)})`)
				: fail(
						`a credential signed by a stranger's key returned ${describe(thief)}`,
						thief.json,
					);
		});
	},
});

const credentialSchemeCase = defineCheck({
	id: "credential.scheme-case-insensitive",
	title: "The Atproto-Space-Credential scheme is recognised regardless of case",
	tier: "must",
	citations: [
		P("0016#presenting-a-space-credential"),
		L("com.atproto.space.getRecord"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const lower = await readShared(ctx, credential, space.uri, {
				scheme: "atproto-space-credential",
			});
			return lower.status === 200
				? pass("a lowercase scheme was accepted")
				: fail(`a lowercase scheme returned ${describe(lower)}`, lower.json);
		});
	},
});

const credentialCrossSpace = defineCheck({
	id: "credential.cross-space-refused",
	title: "A credential for one space cannot read another",
	tier: "must",
	citations: [
		L("com.atproto.space.getRecord"),
		P("0016#presenting-a-space-credential"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const other = await createProbeSpace(ctx, publicRead());
		try {
			await mustCreateRecord(ctx, other.uri, "shared", "b");
			return await withPublicSpace(ctx, async (space, credential) => {
				const ok = await readShared(ctx, credential, space.uri);
				if (ok.status !== 200)
					return fail(`positive control failed: ${describe(ok)}`, ok.json);
				const cross = await readShared(ctx, credential, other.uri);
				return cross.status === 200
					? fail("a space-A credential read space B", cross.json)
					: pass(`cross-space read refused (${describe(cross)})`);
			});
		} finally {
			await deleteProbeSpace(ctx, other.uri);
		}
	},
});

const credentialUnhostedRepo = defineCheck({
	id: "credential.unhosted-repo-not-found",
	title:
		"Credentialed reads of a repo the host does not hold answer RepoNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.getRecord@error:RepoNotFound"),
		L("com.atproto.space.getLatestCommit@error:RepoNotFound"),
		L("com.atproto.space.getRepo@error:RepoNotFound"),
		L("com.atproto.space.listRecords@error:RepoNotFound"),
		L("com.atproto.space.listRepoOps@error:RepoNotFound"),
		L("com.atproto.space.listBlobs@error:RepoNotFound"),
		L("com.atproto.space.getBlob@error:RepoNotFound"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			// A DID no host serves. Its KEM key can't be resolved, so the MAC
			// request carries a well-formed but unanswerable key share — the
			// host must find no repo before it could use one.
			const repo = fakeDid();
			const base = { space: space.uri, repo };
			const reads: Array<[string, Record<string, string>]> = [
				["getRecord", { ...base, collection: POST, rkey: "shared" }],
				["getLatestCommit", base],
				["getRepo", base],
				["listRepoOps", base],
				["listRecords", base],
				["listBlobs", base],
				["getBlob", { ...base, cid: await rawCid(utf8("no such blob")) }],
			];
			const misses: string[] = [];
			for (const [name, params] of reads) {
				const res = await credentialCall(
					ctx,
					credential,
					`com.atproto.space.${name}`,
					{ params },
				);
				if (res.error !== "RepoNotFound")
					misses.push(`${name} → ${describe(res)}`);
			}
			return misses.length
				? fail(`expected RepoNotFound: ${misses.join("; ")}`)
				: pass("all seven reads answered RepoNotFound");
		});
	},
});

const macRequired = defineCheck({
	id: "mac.mac-request-required",
	title:
		"Credentialed reads of a commit or record without a MAC request answer InvalidSpaceMac",
	tier: "must",
	citations: [
		L("com.atproto.space.getLatestCommit@error:InvalidSpaceMac"),
		L("com.atproto.space.getRecord@error:InvalidSpaceMac"),
		L("com.atproto.space.getRepo@error:InvalidSpaceMac"),
		L("com.atproto.space.listRepoOps@error:InvalidSpaceMac"),
		P("0016#requesting-a-mac"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const base = { space: space.uri, repo: ctx.target.did };
			const reads: Array<[string, Record<string, string>]> = [
				["getLatestCommit", base],
				["getRecord", recordParams(ctx, space.uri)],
				["getRepo", base],
				["listRepoOps", base],
			];
			const misses: string[] = [];
			for (const [name, params] of reads) {
				const nsid = `com.atproto.space.${name}`;
				const ok = await credentialGet(ctx, credential, nsid, params);
				if (ok.status !== 200) {
					misses.push(`${name} with a MAC request → ${describe(ok)}`);
					continue;
				}
				const none = await credentialCall(ctx, credential, nsid, {
					params,
					mac: false,
				});
				if (none.error !== "InvalidSpaceMac")
					misses.push(`${name} without → ${describe(none)}`);
				// A request only for another tag is ignored, leaving none.
				const profile =
					name === "getRecord" ? RECORD_MAC_PROFILE : COMMIT_MAC_PROFILE;
				const otherTag = await credentialCall(ctx, credential, nsid, {
					params,
					mac: {
						profile,
						header: (k) =>
							formatMacRequest(profile, k).replace(
								`tag="${profile}"`,
								'tag="some-other-profile"',
							),
					},
				});
				if (otherTag.error !== "InvalidSpaceMac")
					misses.push(`${name} with only another tag → ${describe(otherTag)}`);
			}
			return misses.length
				? fail(misses.join("; "))
				: pass(
						"each served with a MAC request and answered InvalidSpaceMac without one",
					);
		});
	},
});

const macMalformed = defineCheck({
	id: "mac.malformed-request-rejected",
	title: "A malformed MAC request answers InvalidSpaceMac",
	tier: "must",
	citations: [
		L("com.atproto.space.getLatestCommit@error:InvalidSpaceMac"),
		L("com.atproto.space.getRecord@error:InvalidSpaceMac"),
		P("0016#requesting-a-mac"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const commit = { space: space.uri, repo: ctx.target.did };
			const c = COMMIT_MAC_PROFILE;
			const probes: Array<
				[string, Record<string, string>, (k: string) => string]
			> = [
				[
					"invalid keyid",
					commit,
					() => formatMacRequest(c, "did:key:zNotAKey"),
				],
				[
					"keyid not a P-256 key",
					commit,
					() =>
						formatMacRequest(
							c,
							formatDidKey(
								"ES256K",
								new Uint8Array([
									2,
									...crypto.getRandomValues(new Uint8Array(32)),
								]),
							),
						),
				],
				[
					"two requests with the tag",
					commit,
					(k) =>
						`${formatMacRequest(c, k)}, ${formatMacRequest(c, k, { label: "mac2" })}`,
				],
				[
					"an extra parameter",
					commit,
					(k) =>
						formatMacRequest(c, k, {
							params: [["created", Math.floor(Date.now() / 1000)]],
						}),
				],
				[
					"alg other than hmac-sha256",
					commit,
					(k) =>
						formatMacRequest(c, k, { params: [["alg", "ecdsa-p256-sha256"]] }),
				],
				[
					"wrong covered header",
					commit,
					(k) =>
						formatMacRequest(c, k).replace(
							'("atproto-space-commit";sf)',
							'("atproto-space-record";sf)',
						),
				],
				[
					"not a structured field",
					recordParams(ctx, space.uri),
					() => "please",
				],
			];
			const misses: string[] = [];
			for (const [label, params, header] of probes) {
				const nsid = params.rkey
					? "com.atproto.space.getRecord"
					: "com.atproto.space.getLatestCommit";
				const profile = params.rkey ? RECORD_MAC_PROFILE : COMMIT_MAC_PROFILE;
				const res = await credentialCall(ctx, credential, nsid, {
					params,
					mac: { profile, header },
				});
				if (res.error !== "InvalidSpaceMac")
					misses.push(`${label} → ${describe(res)}`);
			}
			return misses.length
				? fail(`expected InvalidSpaceMac: ${misses.join("; ")}`)
				: pass("every malformed MAC request answered InvalidSpaceMac");
		});
	},
});

export const credentialChecks: Check[] = [
	credentialTokenlessPolicies,
	credentialClaims,
	credentialDefaultLifetime,
	credentialSpaceRev,
	credentialKeyP256,
	credentialGarbageDelegation,
	credentialUnverifiableAttestation,
	credentialGarbageAttestation,
	credentialAllowedApps,
	credentialDeletedSpace,
	credentialUnconfirmedRegistration,
	credentialSelfRoundTrip,
	delegationClaims,
	delegationReplay,
	delegationWrongSpace,
	credentialSignatureRequired,
	credentialSignatureByTag,
	credentialSignatureRequirements,
	credentialAudienceBound,
	credentialWrongKey,
	credentialSchemeCase,
	credentialCrossSpace,
	credentialUnhostedRepo,
	macRequired,
	macMalformed,
];
