/**
 * Space credentials, operator-side: issuance (tokenless for public-read
 * spaces, via the target's own delegation tokens otherwise), the refusals
 * getSpaceCredential declares, and presentation — the HTTP message
 * signature, the audience binding and the MAC request every credentialed
 * read of a commit or record must carry.
 *
 * All browser-safe: credential keys, signatures and KEM key shares are
 * WebCrypto (see ../space-auth.ts). Verifying the MACs that come back
 * needs the reference library and lives in ../full/checks.ts.
 */

import { defineCheck } from "../registry.js";
import { asOperator, xrpcGet } from "../http.js";
import { fail, pass, type Check, type CheckContext } from "../model.js";
import { decodeJwt, rawCid, toBase64Url, utf8 } from "../encoding.js";
import {
	COMMIT_MAC_TYPE,
	MAC_HEADER,
	RECORD_MAC_TYPE,
	createCredentialKey,
	formatWantMacHeader,
	formatDidKey,
} from "../space-auth.js";
import {
	FOREIGN_DID,
	POST,
	createProbeSpace,
	credentialCall,
	credentialGet,
	deleteProbeSpace,
	describe,
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
const C = (ref: string) => ({ source: "changeset" as const, ref });

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

// --- issuance ----------------------------------------------------------

const credentialTokenlessPolicies = defineCheck({
	id: "credential.tokenless-by-policy",
	title:
		"Without a delegation token only a public-read space issues; others answer SpaceNotFound",
	tier: "must",
	citations: [
		L("com.atproto.space.getSpaceCredential"),
		L("com.atproto.space.getSpaceCredential@error:SpaceNotFound"),
		L("com.atproto.memberspace.policy"),
		L("com.atproto.personalspace.policy"),
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
				if (res.result.error !== "SpaceNotFound")
					misses.push(`${label} → ${describe(res.result)}`);
			}
			return misses.length
				? fail(`expected SpaceNotFound: ${misses.join("; ")}`)
				: pass(
						"public-read issued; closed memberspace and personalspace answered SpaceNotFound",
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
		L("com.atproto.space.getSpaceCredential"),
		C("funky-dryers-draw"),
		C("plain-keys-resolve"),
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
			// Credentials carry no audience: each use is bound to one by its
			// HTTP signature instead.
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
	title: "Credentials live 600 seconds, the reference default",
	tier: "should",
	citations: [
		{
			source: "reference",
			ref: "@atproto/space SPACE_TOKEN_TYPES.credential.expiresInSec",
		},
	],
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

const credentialKidP256 = defineCheck({
	id: "credential.kid-must-be-p256",
	title:
		"getSpaceCredential refuses a credentialKid that is not a P-256 did:key",
	tier: "must",
	citations: [L("com.atproto.space.getSpaceCredential")],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		try {
			// A well-formed secp256k1 did:key: valid syntax, wrong curve. The
			// credential could never be presented — HTTP signatures are P-256.
			const k256 = formatDidKey(
				"ES256K",
				new Uint8Array([0x02, ...crypto.getRandomValues(new Uint8Array(32))]),
			);
			const bad = await requestCredential(ctx, space.uri, {
				credentialKid: k256,
			});
			if (bad.credential)
				return fail("issued a credential bound to a secp256k1 key");
			const notKey = await requestCredential(ctx, space.uri, {
				credentialKid: ctx.target.did,
			});
			if (notKey.credential)
				return fail("issued a credential bound to a non-key DID");
			const good = await requestCredential(ctx, space.uri);
			return good.credential
				? pass(
						`refused secp256k1 (${describe(bad.result)}) and non-key (${describe(notKey.result)}) kids; P-256 issued`,
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
		L("com.atproto.space.getSpaceCredential@error:InvalidDelegationToken"),
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
	const input = `${part({ alg: "ES256", typ: "atproto-client-attestation+jwt" })}.${part(
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
	L("com.atproto.space.getSpaceCredential@error:InvalidClientAttestation"),
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
	title:
		"A memberspace with allowedApps refuses an unattested app with AppNotAuthorized",
	tier: "must",
	citations: [
		L("com.atproto.space.getSpaceCredential@error:AppNotAuthorized"),
		L("com.atproto.memberspace.policy"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		// publicRead clears the user perimeter (checked first), so only the
		// app perimeter is left to refuse.
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
			return res.result.error === "AppNotAuthorized"
				? pass("refused with AppNotAuthorized")
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
	title: "After deleteSpace, getSpaceCredential answers SpaceDeleted",
	tier: "must",
	citations: [
		L("com.atproto.space.deleteSpace"),
		L("com.atproto.space.getSpaceCredential@error:SpaceDeleted"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		const space = await createProbeSpace(ctx, publicRead());
		// Positive control, so a target that never issues cannot pass.
		const before = await requestCredential(ctx, space.uri);
		if (!before.credential) {
			await deleteProbeSpace(ctx, space.uri);
			return fail(
				`could not obtain a credential before deletion (${describe(before.result)})`,
			);
		}
		await deleteProbeSpace(ctx, space.uri);
		const after = await requestCredential(ctx, space.uri);
		if (after.credential)
			return fail("a deleted space still issued a credential");
		// The durable tombstone: a syncer that missed notifySpaceDeleted learns
		// it here on renewal — tokenless, as a public space's syncer would ask.
		return after.result.error === "SpaceDeleted"
			? pass("answered SpaceDeleted")
			: fail(
					`answered ${describe(after.result)}, expected SpaceDeleted`,
					after.result.json,
				);
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
		L("com.atproto.space.getSpaceCredential"),
		L("com.atproto.space.getRecord"),
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
				return fail(`getSpaceCredential ${describe(result)}`, result.json);
			const read = await readShared(ctx, credential, space.uri);
			if (read.status !== 200)
				return fail(`credential read failed: ${describe(read)}`, read.json);
			return read.headers.get(MAC_HEADER)
				? pass("delegation → credential → MAC'd read works")
				: fail("the credentialed read carried no Atproto-Space-Mac header");
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
		C("plain-keys-resolve"),
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
			if (typeof payload.jti !== "string" || !payload.jti)
				problems.push("no jti");
			if (!(Number(payload.exp) > Math.floor(Date.now() / 1000) - 5))
				problems.push("already expired");
			return problems.length
				? fail(`delegation token: ${problems.join(", ")}`, { header, payload })
				: pass("typ/kid/iss/sub/aud as specified");
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
		L("com.atproto.space.getSpaceCredential@error:InvalidDelegationToken"),
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
		L("com.atproto.space.getSpaceCredential@error:InvalidDelegationToken"),
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
	L("com.atproto.space.listRepos"),
	C("funky-dryers-draw"),
	C("open-spaces-greet"),
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
			return bare.status >= 400 && bare.status < 500
				? pass(`signed read 200; unsigned read refused (${describe(bare)})`)
				: fail(
						`an unsigned credential read returned ${describe(bare)}`,
						bare.json,
					);
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
		// The audience is the service being called; a signature over some
		// other DID is a request meant for someone else, replayed here.
		return withPublicSpace(ctx, async (space, credential) => {
			const ok = await readShared(ctx, credential, space.uri);
			if (ok.status !== 200)
				return fail(`positive control failed: ${describe(ok)}`, ok.json);
			const misaddressed = await readShared(ctx, credential, space.uri, {
				audience: FOREIGN_DID,
			});
			if (misaddressed.status < 400 || misaddressed.status >= 500) {
				return fail(
					`a misaddressed repo-host read returned ${describe(misaddressed)}`,
					misaddressed.json,
				);
			}
			// The same at the space host, whose audience is the authority.
			const listRepos = (audience: string) =>
				credentialCall(ctx, credential, "com.atproto.space.listRepos", {
					params: { space: space.uri },
					audience,
				});
			const hostOk = await listRepos(ctx.target.did);
			if (hostOk.status !== 200)
				return fail(
					`listRepos positive control failed: ${describe(hostOk)}`,
					hostOk.json,
				);
			const hostWrong = await listRepos(FOREIGN_DID);
			return hostWrong.status >= 400 && hostWrong.status < 500
				? pass(
						`refused signatures over another audience at the repo host (${describe(misaddressed)}) and space host (${describe(hostWrong)})`,
					)
				: fail(
						`a misaddressed listRepos returned ${describe(hostWrong)}`,
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
			return thief.status >= 400 && thief.status < 500
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
	citations: [C("open-spaces-greet"), L("com.atproto.space.getRecord")],
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
	citations: [L("com.atproto.space.getRecord")],
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
			const share = (await createCredentialKey()).did;
			const base = { space: space.uri, repo };
			const reads: Array<[string, Record<string, string>, string | false]> = [
				[
					"getRecord",
					{ ...base, collection: POST, rkey: "shared" },
					formatWantMacHeader(RECORD_MAC_TYPE, share),
				],
				["getLatestCommit", base, formatWantMacHeader(COMMIT_MAC_TYPE, share)],
				["getRepo", base, formatWantMacHeader(COMMIT_MAC_TYPE, share)],
				["listRepoOps", base, formatWantMacHeader(COMMIT_MAC_TYPE, share)],
				["listRecords", base, false],
				["listBlobs", base, false],
				[
					"getBlob",
					{ ...base, cid: await rawCid(utf8("no such blob")) },
					false,
				],
			];
			const misses: string[] = [];
			for (const [name, params, wantMac] of reads) {
				const res = await credentialCall(
					ctx,
					credential,
					`com.atproto.space.${name}`,
					{ params, wantMac },
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

const macWantRequired = defineCheck({
	id: "mac.want-mac-required",
	title:
		"Credentialed reads of a commit or record without Atproto-Space-Want-Mac answer BadSpaceMac",
	tier: "must",
	citations: [
		L("com.atproto.space.getLatestCommit@error:BadSpaceMac"),
		L("com.atproto.space.getRecord@error:BadSpaceMac"),
		L("com.atproto.space.getRepo@error:BadSpaceMac"),
		L("com.atproto.space.listRepoOps@error:BadSpaceMac"),
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
				// Positive control per method: with the header it is served.
				const ok = await credentialGet(ctx, credential, nsid, params);
				if (ok.status !== 200) {
					misses.push(`${name} with a MAC request → ${describe(ok)}`);
					continue;
				}
				const res = await credentialCall(ctx, credential, nsid, {
					params,
					wantMac: false,
				});
				if (res.error !== "BadSpaceMac")
					misses.push(`${name} without → ${describe(res)}`);
			}
			return misses.length
				? fail(misses.join("; "))
				: pass(
						"each served with a MAC request and answered BadSpaceMac without one",
					);
		});
	},
});

const macMalformed = defineCheck({
	id: "mac.malformed-want-mac-rejected",
	title: "A malformed or mistyped Atproto-Space-Want-Mac answers BadSpaceMac",
	tier: "must",
	citations: [
		L("com.atproto.space.getLatestCommit@error:BadSpaceMac"),
		L("com.atproto.space.getRecord@error:BadSpaceMac"),
	],
	needs: ["operator"],
	destructive: true,
	async run(ctx) {
		return withPublicSpace(ctx, async (space, credential) => {
			const share = (await createCredentialKey()).did;
			const commit = { space: space.uri, repo: ctx.target.did };
			const probes: Array<[string, string, Record<string, string>, string]> = [
				[
					"bad key share",
					"getLatestCommit",
					commit,
					`type="${COMMIT_MAC_TYPE}", ver=1, key_share="did:key:zNotAKey"`,
				],
				[
					"unsupported version",
					"getLatestCommit",
					commit,
					`type="${COMMIT_MAC_TYPE}", ver=99, key_share="${share}"`,
				],
				[
					"record read asking for a commit MAC",
					"getRecord",
					recordParams(ctx, space.uri),
					formatWantMacHeader(COMMIT_MAC_TYPE, share),
				],
				[
					"not a structured header",
					"getRecord",
					recordParams(ctx, space.uri),
					"please",
				],
			];
			const misses: string[] = [];
			for (const [label, name, params, header] of probes) {
				const res = await credentialCall(
					ctx,
					credential,
					`com.atproto.space.${name}`,
					{ params, wantMac: header },
				);
				if (res.error !== "BadSpaceMac")
					misses.push(`${label} → ${describe(res)}`);
			}
			return misses.length
				? fail(`expected BadSpaceMac: ${misses.join("; ")}`)
				: pass("every malformed MAC request answered BadSpaceMac");
		});
	},
});

export const credentialChecks: Check[] = [
	credentialTokenlessPolicies,
	credentialClaims,
	credentialDefaultLifetime,
	credentialKidP256,
	credentialGarbageDelegation,
	credentialUnverifiableAttestation,
	credentialGarbageAttestation,
	credentialAllowedApps,
	credentialDeletedSpace,
	credentialSelfRoundTrip,
	delegationClaims,
	delegationReplay,
	delegationWrongSpace,
	credentialSignatureRequired,
	credentialAudienceBound,
	credentialWrongKey,
	credentialSchemeCase,
	credentialCrossSpace,
	credentialUnhostedRepo,
	macWantRequired,
	macMalformed,
];
