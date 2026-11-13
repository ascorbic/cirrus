/**
 * Worker-side verification of space credentials and delegation tokens.
 *
 * A space credential is presented as `Authorization: Atproto-Space-Credential
 * <jwt>` (scheme case-insensitive), with an `Atproto-Space-Audience` header
 * naming the service being called and an HTTP message signature over both,
 * by the P-256 key the credential is bound to (`cnf.kid`). A delegation
 * token arrives in the `getSpaceCredential` request body.
 *
 * Everything here is stateless except the revocation and replay checks,
 * which are one RPC each to the space DO. Key resolution goes through the
 * host's DID resolver with a forced refresh on signature failure (handled
 * inside `verifySpaceToken`) so key rotation doesn't strand callers.
 */

import {
	SpaceSignatureError,
	SpaceTokenError,
	spaceHostAud,
	verifyCredentialSig,
	verifySpaceToken,
} from "@atproto/space";
import { SpaceError } from "./errors.js";
import type { SpaceErrorCode } from "./errors.js";
import { parseSpaceUri } from "./space-uri.js";
import type { SpaceRef } from "./space-uri.js";

/** Resolve an issuer DID's `#atproto` key to a did:key string. */
export type GetSigningKey = (
	iss: string,
	forceRefresh: boolean,
) => Promise<string>;

/** Record a single-use key; false when it was already seen. */
export type CheckReplay = (
	kind: string,
	key: string,
	expiresAtSec: number,
) => Promise<boolean>;

/** Whether a credential has been revoked by the space's authority. */
export type CheckRevoked = (jti: string) => Promise<boolean>;

export const SPACE_CREDENTIAL_SCHEME = "Atproto-Space-Credential";
export const SPACE_AUDIENCE_HEADER = "atproto-space-audience";

/**
 * Split an Authorization header into scheme and token. The scheme is
 * case-insensitive, as for every HTTP authentication scheme.
 */
function splitAuthorization(
	authorization: string | undefined,
): { scheme: string; token: string } | null {
	if (!authorization) return null;
	const parts = authorization.split(" ");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { scheme: parts[0].toLowerCase(), token: parts[1] };
}

/** Whether an Authorization header carries a space credential. */
export function isSpaceCredentialAuth(
	authorization: string | undefined,
): boolean {
	return (
		splitAuthorization(authorization)?.scheme ===
		SPACE_CREDENTIAL_SCHEME.toLowerCase()
	);
}

export interface VerifyCredentialOpts {
	/** Request headers, lower-cased names. */
	headers: Record<string, string | undefined>;
	/**
	 * The DID this request is addressed to: the repo DID for repo-host
	 * reads, the authority DID for space-host methods. The signed
	 * `Atproto-Space-Audience` header must name it.
	 */
	audience: string;
	getSigningKey: GetSigningKey;
	checkRevoked: CheckRevoked;
}

export interface SpaceCredentialResult {
	kind: "credential";
	/** The credential issuer: the space's authority DID. */
	iss: string;
	jti: string;
}

/**
 * Verify a space credential presented against `space`: the token itself
 * (type, signature against the issuer's `#atproto` key, expiry, lifetime),
 * its issuer being the space's authority and its subject the space, the
 * HTTP message signature by its bound key over the credential and the
 * audience, the audience naming this service, and revocation.
 */
export async function verifySpaceCredentialAuth(
	space: SpaceRef,
	opts: VerifyCredentialOpts,
): Promise<SpaceCredentialResult> {
	const authorization = splitAuthorization(opts.headers.authorization);
	if (
		!authorization ||
		authorization.scheme !== SPACE_CREDENTIAL_SCHEME.toLowerCase()
	) {
		throw new SpaceError("MissingJwt", "Missing space credential");
	}

	let payload;
	try {
		({ payload } = await verifySpaceToken("credential", authorization.token, {
			getSigningKey: opts.getSigningKey,
		}));
	} catch (err) {
		throw tokenError(err, "BadJwt");
	}
	const subject = parseSpaceUri(payload.sub);
	if (!subject) {
		throw new SpaceError(
			"BadJwtSub",
			`Space token subject is not a space URI: ${payload.sub}`,
		);
	}
	if (payload.iss !== subject.authority) {
		throw new SpaceError(
			"BadJwtIss",
			"Space credential issuer is not the space authority",
		);
	}

	const audience = opts.headers[SPACE_AUDIENCE_HEADER];
	if (!audience?.startsWith("did:")) {
		throw new SpaceError(
			"BadSpaceSignature",
			"Missing or invalid space audience DID",
		);
	}
	try {
		await verifyCredentialSig(opts.headers, payload.cnf.kid);
	} catch (err) {
		if (err instanceof SpaceSignatureError) {
			throw new SpaceError("BadSpaceSignature", err.message);
		}
		throw err;
	}
	if (audience !== opts.audience) {
		throw new SpaceError(
			"BadSpaceAudience",
			"Space audience does not match the request",
		);
	}
	if (payload.sub !== space.uri) {
		throw new SpaceError(
			"InvalidCredential",
			"Credential is not scoped to this space",
		);
	}
	if (await opts.checkRevoked(payload.jti)) {
		throw new SpaceError(
			"CredentialRevoked",
			"Space credential has been revoked",
		);
	}
	return { kind: "credential", iss: payload.iss, jti: payload.jti };
}

export interface DelegationResult {
	/** The user the delegation token vouches for. */
	userDid: string;
}

/**
 * Verify a delegation token from a `getSpaceCredential` body: signature
 * against the issuer's `#atproto` key, audience the space authority's
 * `#atproto_pds`, subject the requested space, single use by `(iss, jti)`.
 * Any failure is `InvalidDelegationToken`: the token arrives in the body
 * rather than as the request's authorization, so it is an invalid request,
 * not an authentication failure.
 */
export async function verifyDelegationToken(
	token: string,
	space: SpaceRef,
	opts: { getSigningKey: GetSigningKey; checkReplay: CheckReplay },
): Promise<DelegationResult> {
	let payload;
	try {
		({ payload } = await verifySpaceToken("delegation", token, {
			getSigningKey: opts.getSigningKey,
		}));
	} catch (err) {
		throw tokenError(err, "InvalidDelegationToken", "InvalidDelegationToken");
	}
	if (payload.sub !== space.uri) {
		throw new SpaceError(
			"InvalidDelegationToken",
			"Delegation token subject does not match requested space",
		);
	}
	if (
		payload.aud !== spaceHostAud(space.authority as `did:${string}:${string}`)
	) {
		throw new SpaceError(
			"InvalidDelegationToken",
			"Delegation token audience does not match the space authority",
		);
	}
	if (!payload.iss.startsWith("did:")) {
		throw new SpaceError(
			"InvalidDelegationToken",
			"Delegation token issuer is not a DID",
		);
	}
	const fresh = await opts.checkReplay(
		"delegation",
		`${payload.iss}:${payload.jti}`,
		payload.exp,
	);
	if (!fresh) {
		throw new SpaceError(
			"InvalidDelegationToken",
			"Delegation token has already been used",
		);
	}
	return { userDid: payload.iss };
}

function tokenError(
	err: unknown,
	fallback: SpaceErrorCode,
	override?: SpaceErrorCode,
): SpaceError {
	// Server-side detail for operators; clients get the token library's
	// message, never infrastructure internals.
	console.warn("space token verification failed:", err);
	if (err instanceof SpaceTokenError) {
		return new SpaceError(override ?? err.code, err.message);
	}
	// DID resolution failures and other infrastructure errors must surface
	// as auth errors, never 500s.
	return new SpaceError(override ?? fallback, "Token verification failed");
}
