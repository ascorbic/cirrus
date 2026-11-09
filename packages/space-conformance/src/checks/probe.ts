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
	COMMIT_MAC_TYPE,
	RECORD_MAC_TYPE,
	SPACE_CREDENTIAL_SCHEME,
	createCredentialKey,
	encapsulate,
	formatWantMacHeader,
	spaceSigHeaders,
	type CredentialKey,
	type MacType,
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
	const res = await xrpcPost(
		asOperator(ctx),
		"com.atproto.space.createSpace",
		{ spaceType: PROBE_TYPE, skey, policy },
	);
	if (res.status !== 200) {
		throw new Error(
			`createSpace failed: ${res.status} ${res.error ?? ""} ${JSON.stringify(res.json)}`,
		);
	}
	const uri = (res.json as { uri: string }).uri;
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
 * Ask the space's authority for a credential. Nothing authenticates the
 * request itself: the body carries the key to bind, and optionally a
 * delegation token (who the user is) and a client attestation (which app).
 */
export async function requestCredential(
	ctx: CheckContext,
	space: string,
	opts: {
		delegationToken?: string;
		clientAttestation?: string;
		credentialKid?: string;
		key?: CredentialKey;
	} = {},
): Promise<{ result: XrpcResult; credential?: Credential }> {
	const key = opts.key ?? (await createCredentialKey());
	const result = await xrpcPost(ctx, "com.atproto.space.getSpaceCredential", {
		space,
		credentialKid: opts.credentialKid ?? key.did,
		...(opts.delegationToken ? { delegationToken: opts.delegationToken } : {}),
		...(opts.clientAttestation
			? { clientAttestation: opts.clientAttestation }
			: {}),
	});
	if (result.status === 200) {
		const credential = (result.json as { credential?: unknown }).credential;
		if (typeof credential === "string") {
			return { result, credential: { credential, key, space } };
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
			`tokenless getSpaceCredential for a public-read space failed: ${result.status} ${result.error ?? ""}`,
		);
	}
	return credential;
}

/**
 * Obtain a credential the way a real app does: ask the target's own
 * `getDelegationToken` (with the operator session) for a delegation token,
 * then exchange it at `getSpaceCredential`. It needs no harness-held
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

/** Which MAC each repo-host read asks for. */
const MAC_TYPES: Record<string, MacType> = {
	"com.atproto.space.getLatestCommit": COMMIT_MAC_TYPE,
	"com.atproto.space.getRepo": COMMIT_MAC_TYPE,
	"com.atproto.space.listRepoOps": COMMIT_MAC_TYPE,
	"com.atproto.space.getRecord": RECORD_MAC_TYPE,
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
	 * The MAC to ask for. Defaults to what the method returns (commit or
	 * record) for the four MAC'd reads, nothing otherwise. `false` omits the
	 * header; a string sends it verbatim (malformed-header probes).
	 */
	wantMac?: MacType | false | string;
	/** Authorization scheme spelling; defaults to `Atproto-Space-Credential`. */
	scheme?: string;
	/** Sign with this key instead of the credential's own. */
	signWith?: CredentialKey;
	/** Send no signature headers at all. */
	unsigned?: boolean;
}

export interface CredentialResult extends XrpcResult {
	/** The KEM shared secret, when a MAC was requested. */
	sharedSecret?: Uint8Array;
	macType?: MacType;
}

/** Present a credential on one request: signature, audience, MAC request. */
export async function credentialCall(
	ctx: CheckContext,
	credential: Credential,
	nsid: string,
	opts: CredentialCallOptions = {},
): Promise<CredentialResult> {
	const repo = opts.params?.repo;
	const audience =
		opts.audience ?? repo ?? spaceAuthority(credential.space);
	const authorization = `${opts.scheme ?? SPACE_CREDENTIAL_SCHEME} ${credential.credential}`;
	const headers = new Headers(
		opts.unsigned
			? { authorization }
			: await spaceSigHeaders(opts.signWith ?? credential.key, {
					authorization,
					audience,
				}),
	);

	let sharedSecret: Uint8Array | undefined;
	let macType: MacType | undefined;
	const want = opts.wantMac ?? MAC_TYPES[nsid];
	if (typeof want === "string" && want !== COMMIT_MAC_TYPE && want !== RECORD_MAC_TYPE) {
		headers.set("atproto-space-want-mac", want);
	} else if (want) {
		if (!repo) throw new Error(`${nsid}: a MAC request needs the repo DID`);
		const { keyShare, sharedSecret: secret } = await encapsulate(
			await kemKeyFor(ctx, repo),
		);
		headers.set("atproto-space-want-mac", formatWantMacHeader(want, keyShare));
		sharedSecret = secret;
		macType = want;
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
		response = await ctx.fetch(
			xrpcUrl(ctx.target.origin, nsid, opts.params),
			{ method: "GET", headers },
		);
	}
	const result = await toResult(response);
	return {
		...result,
		...(sharedSecret ? { sharedSecret } : {}),
		...(macType ? { macType } : {}),
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

/** Summarise a response for a detail line. */
export const describe = (res: XrpcResult): string =>
	`${res.status}${res.error ? ` ${res.error}` : ""}`;

export const isAuthRefusal = (res: XrpcResult): boolean =>
	res.status === 401 || res.status === 403;
