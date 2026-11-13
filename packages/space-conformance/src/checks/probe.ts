/**
 * Browser-safe helpers the checks share: probe spaces, operator writes,
 * obtaining a space credential, and presenting it (HTTP signature plus,
 * where the method returns a commit or record, a MAC request).
 *
 * Everything here needs only `fetch` and WebCrypto, so the operator
 * checks — which include the operator's own credential flow — run in a
 * browser as well as in the CLI and the vitest adapter.
 */

import {
	asOperator,
	toResult,
	xrpcGet,
	xrpcPost,
	xrpcUrl,
	type XrpcResult,
} from "../http.js";
import type { CheckContext } from "../model.js";
import { kemKeyFor } from "../did.js";
import {
	COMMIT_MAC_PROFILE,
	RECORD_MAC_PROFILE,
	SPACE_CREDENTIAL_SCHEME,
	createCredentialKey,
	encapsulate,
	formatMacRequest,
	spaceSigHeaders,
	type CredentialKey,
	type CredentialSigOptions,
	type MacProfile,
} from "../space-auth.js";

// The probe collections and space type are published, resolvable
// lexicons under the suite's own authority (see ../../probe-lexicons) —
// so strict, dynamically-resolving targets can validate them, while
// AppViews ignore them (nothing under earth.cirrus.check.* is app.bsky.*).
export const POST = "earth.cirrus.check.note";
export const note = (text: string) => ({ $type: POST, text });
export const PROBE_TYPE = "earth.cirrus.check.space";

/**
 * A syntactically valid DID no host serves: the authority of spaces the
 * operator does not own, and the subject of reads of a repo no host holds.
 */
export const FOREIGN_DID = "did:web:space-conformance.invalid";

// --- policies ----------------------------------------------------------

export type Policy = { $type: string } & Record<string, unknown>;

export const personalspace = (): Policy => ({
	$type: "com.atproto.personalspace.policy",
});

export const memberspace = (
	config: {
		publicRead?: boolean;
		publicWrite?: boolean;
		allowedApps?: string[];
		publishPolicy?: boolean;
		publishMembers?: boolean;
	} = {},
): Policy => ({ $type: "com.atproto.memberspace.policy", ...config });

export const managedspace = (
	managingApp: string,
	config: { publishPolicy?: boolean } = {},
): Policy => ({
	$type: "com.atproto.managedspace.policy",
	managingApp,
	...config,
});

/** A public-read memberspace: anyone may obtain a credential, no token needed. */
export const publicRead = (): Policy => memberspace({ publicRead: true });

// --- probe spaces ------------------------------------------------------

export interface ProbeSpace {
	uri: string;
	type: string;
	skey: string;
}

/** A run-unique skey so probe spaces never collide with real ones. */
export function probeSkey(): string {
	const rand = crypto.getRandomValues(new Uint8Array(8));
	return `probe${Array.from(rand, (b) => b.toString(36))
		.join("")
		.slice(0, 10)}`;
}

/** A space URI under `did` that nobody has created. */
export const unknownSpaceUri = (did: string): string =>
	`at://${did}/space/${PROBE_TYPE}/${probeSkey()}`;

/** The authority DID a space URI names. */
export const spaceAuthority = (space: string): string =>
	space.replace(/^at:\/\//, "").split("/")[0]!;

/**
 * Create a probe space owned by the target's operator. The default policy
 * is a closed memberspace — only the authority can read it.
 */
export async function createProbeSpace(
	ctx: CheckContext,
	policy: Policy = memberspace(),
	skey: string = probeSkey(),
): Promise<ProbeSpace> {
	const res = await xrpcPost(asOperator(ctx), "com.atproto.space.createSpace", {
		spaceType: PROBE_TYPE,
		skey,
		policy,
	});
	if (res.status !== 200) {
		throw new Error(
			`createSpace failed: ${res.status} ${res.error ?? ""} ${JSON.stringify(res.json)}`,
		);
	}
	const uri = (res.json as { space: string }).space;
	if (typeof uri !== "string") {
		throw new Error(
			`createSpace returned no space: ${JSON.stringify(res.json)}`,
		);
	}
	return { uri, type: PROBE_TYPE, skey };
}

/** Delete a probe space, best-effort (cleanup). */
export async function deleteProbeSpace(
	ctx: CheckContext,
	space: string,
): Promise<void> {
	await xrpcPost(asOperator(ctx), "com.atproto.space.deleteSpace", {
		space,
	}).catch(() => {});
}

/** Operator creates a record in a space; returns the response. */
export async function operatorCreateRecord(
	ctx: CheckContext,
	space: string,
	collection: string,
	rkey: string,
	record: Record<string, unknown>,
): Promise<XrpcResult> {
	return xrpcPost(asOperator(ctx), "com.atproto.space.createRecord", {
		space,
		repo: ctx.target.did,
		collection,
		rkey,
		record,
	});
}

/** Operator write that must succeed (setup, not the thing under test). */
export async function mustCreateRecord(
	ctx: CheckContext,
	space: string,
	rkey: string,
	text = rkey,
): Promise<{ uri: string; cid: string }> {
	const res = await operatorCreateRecord(ctx, space, POST, rkey, note(text));
	if (res.status !== 200) {
		throw new Error(
			`setup createRecord failed: ${res.status} ${res.error ?? ""}`,
		);
	}
	return res.json as { uri: string; cid: string };
}

/** Operator's own read of its repo in a space (no MAC needed or asked). */
export function operatorGetRecord(
	ctx: CheckContext,
	space: string,
	rkey: string,
	collection = POST,
): Promise<XrpcResult> {
	return xrpcGet(asOperator(ctx), "com.atproto.space.getRecord", {
		space,
		repo: ctx.target.did,
		collection,
		rkey,
	});
}

// --- credentials -------------------------------------------------------

export interface Credential {
	credential: string;
	key: CredentialKey;
	/** The space it was issued for. */
	space: string;
}

/**
 * Ask the space's authority to authorise sync. Nothing authenticates the
 * request itself: the body carries the key to bind, and optionally a
 * delegation token (who the user is), a client attestation (which app)
 * and a `notify` registration.
 */
export async function requestCredential(
	ctx: CheckContext,
	space: string,
	opts: {
		delegationToken?: string;
		clientAttestation?: string;
		credentialKey?: string;
		key?: CredentialKey;
		notify?: { endpoint: string; token: string };
	} = {},
): Promise<{
	result: XrpcResult;
	credential?: Credential;
	spaceRev?: string;
}> {
	const key = opts.key ?? (await createCredentialKey());
	const result = await xrpcPost(ctx, "com.atproto.space.authorizeSpaceSync", {
		space,
		credentialKey: opts.credentialKey ?? key.did,
		...(opts.delegationToken ? { delegationToken: opts.delegationToken } : {}),
		...(opts.clientAttestation
			? { clientAttestation: opts.clientAttestation }
			: {}),
		...(opts.notify ? { notify: opts.notify } : {}),
	});
	if (result.status === 200) {
		const body = result.json as { credential?: unknown; spaceRev?: unknown };
		if (typeof body.credential === "string") {
			return {
				result,
				credential: { credential: body.credential, key, space },
				...(typeof body.spaceRev === "string"
					? { spaceRev: body.spaceRev }
					: {}),
			};
		}
	}
	return { result };
}

/** A tokenless credential for a public-read space; throws if refused. */
export async function obtainPublicCredential(
	ctx: CheckContext,
	space: string,
): Promise<Credential> {
	const { result, credential } = await requestCredential(ctx, space);
	if (!credential) {
		throw new Error(
			`tokenless authorizeSpaceSync for a public-read space failed: ${result.status} ${result.error ?? ""}`,
		);
	}
	return credential;
}

/**
 * Obtain a credential the way a real app does: ask the target's own
 * `getDelegationToken` (with the operator session) for a delegation token,
 * then exchange it at `authorizeSpaceSync`. It needs no harness-held
 * reader key, so it runs against any real PDS and exercises the target's
 * own token minting.
 */
export async function obtainCredentialViaDelegation(
	ctx: CheckContext,
	space: string,
): Promise<{
	result: XrpcResult;
	credential?: Credential;
	delegation: XrpcResult;
}> {
	const delegation = await xrpcGet(
		asOperator(ctx),
		"com.atproto.space.getDelegationToken",
		{ space },
	);
	if (delegation.status !== 200) {
		return { result: delegation, delegation };
	}
	const token = (delegation.json as { token: string }).token;
	const { result, credential } = await requestCredential(ctx, space, {
		delegationToken: token,
	});
	return { result, delegation, ...(credential ? { credential } : {}) };
}

/** Which MAC profile each repo-host read asks for. */
const MAC_PROFILES: Record<string, MacProfile> = {
	"com.atproto.space.getLatestCommit": COMMIT_MAC_PROFILE,
	"com.atproto.space.getRepo": COMMIT_MAC_PROFILE,
	"com.atproto.space.listRepoOps": COMMIT_MAC_PROFILE,
	"com.atproto.space.getRecord": RECORD_MAC_PROFILE,
};

export interface CredentialCallOptions {
	/** Query params (GET) — or omit and pass `body` for a procedure. */
	params?: Record<string, string | undefined>;
	body?: unknown;
	/**
	 * The audience DID: the service being called. Defaults to the `repo`
	 * param (a repo-host read), else the space's authority (a space-host
	 * method).
	 */
	audience?: string;
	/**
	 * The MAC to ask for. Defaults to the profile of what the method returns
	 * (commit or record) for the four MAC'd reads, nothing otherwise. `false`
	 * sends no `Accept-Signature`; an object requests the profile with a
	 * custom label or extra parameters; a function builds the whole header
	 * from a fresh key share (malformed-request probes).
	 */
	mac?:
		| MacProfile
		| false
		| {
				profile: MacProfile;
				label?: string;
				params?: Array<[string, string | number]>;
		  }
		| { header: (keyShare: string) => string; profile: MacProfile };
	/** Authorization scheme spelling; defaults to `Atproto-Space-Credential`. */
	scheme?: string;
	/** Sign with this key instead of the credential's own. */
	signWith?: CredentialKey;
	/** Signature label, parameters, components or tag overrides. */
	signature?: Omit<CredentialSigOptions, "authorization" | "audience">;
	/** Replace the signature headers wholesale (e.g. two signatures). */
	signatureHeaders?: (
		defaults: Record<string, string>,
	) => Promise<Record<string, string>>;
	/** Send no signature headers at all. */
	unsigned?: boolean;
}

export interface CredentialResult extends XrpcResult {
	/** The MAC request's encapsulation, when a MAC was requested. */
	keyShare?: string;
	sharedSecret?: Uint8Array;
	macProfile?: MacProfile;
}

/** Present a credential on one request: signature, audience, MAC request. */
export async function credentialCall(
	ctx: CheckContext,
	credential: Credential,
	nsid: string,
	opts: CredentialCallOptions = {},
): Promise<CredentialResult> {
	const repo = opts.params?.repo;
	const audience = opts.audience ?? repo ?? spaceAuthority(credential.space);
	const authorization = `${opts.scheme ?? SPACE_CREDENTIAL_SCHEME} ${credential.credential}`;
	let sigHeaders: Record<string, string> = opts.unsigned
		? { authorization }
		: await spaceSigHeaders(opts.signWith ?? credential.key, {
				authorization,
				audience,
				...opts.signature,
			});
	if (opts.signatureHeaders)
		sigHeaders = await opts.signatureHeaders(sigHeaders);
	const headers = new Headers(sigHeaders);

	let keyShare: string | undefined;
	let sharedSecret: Uint8Array | undefined;
	let macProfile: MacProfile | undefined;
	const mac = opts.mac ?? MAC_PROFILES[nsid];
	if (mac) {
		if (!repo) throw new Error(`${nsid}: a MAC request needs the repo DID`);
		const profile = typeof mac === "string" ? mac : mac.profile;
		// A repo nobody hosts has no KEM key to resolve; a fresh P-256 key
		// stands in, giving a well-formed request the host must refuse anyway.
		const kem = await kemKeyFor(ctx, repo).catch(
			async () => (await createCredentialKey()).did,
		);
		const enc = await encapsulate(kem);
		headers.set(
			"accept-signature",
			typeof mac === "object" && "header" in mac
				? mac.header(enc.keyShare)
				: formatMacRequest(
						profile,
						enc.keyShare,
						typeof mac === "object" ? mac : {},
					),
		);
		keyShare = enc.keyShare;
		sharedSecret = enc.sharedSecret;
		macProfile = profile;
	}

	let response: Response;
	if (opts.body !== undefined) {
		headers.set("Content-Type", "application/json");
		response = await ctx.fetch(xrpcUrl(ctx.target.origin, nsid), {
			method: "POST",
			headers,
			body: JSON.stringify(opts.body),
		});
	} else {
		response = await ctx.fetch(xrpcUrl(ctx.target.origin, nsid, opts.params), {
			method: "GET",
			headers,
		});
	}
	const result = await toResult(response);
	return {
		...result,
		...(keyShare ? { keyShare } : {}),
		...(sharedSecret ? { sharedSecret } : {}),
		...(macProfile ? { macProfile } : {}),
	};
}

/** A credential-authenticated GET with the default audience and MAC request. */
export function credentialGet(
	ctx: CheckContext,
	credential: Credential,
	nsid: string,
	params: Record<string, string | undefined>,
): Promise<CredentialResult> {
	return credentialCall(ctx, credential, nsid, { params });
}

/** Run named probes and fail with every one that missed, not just the first. */
export async function expectEach(
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
	return { ok: misses.length === 0, detail: misses.join("; "), evidence };
}

export const errorIs =
	(...names: string[]) =>
	(r: XrpcResult) =>
		r.error !== undefined && names.includes(r.error);

/** Summarise a response for a detail line. */
export const describe = (res: XrpcResult): string =>
	`${res.status}${res.error ? ` ${res.error}` : ""}`;

const isAuthRefusal = (res: XrpcResult): boolean =>
	res.status === 401 || res.status === 403;
