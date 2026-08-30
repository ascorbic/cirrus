/**
 * Worker-side verification of space credentials and delegation tokens.
 *
 * Everything here is stateless except the replay checks, which are one RPC
 * to the space DO's `replay` table. Key resolution goes through the host's
 * DID resolver with a forced refresh on signature failure (handled inside
 * `verifySpaceToken`) so key rotation doesn't strand callers.
 */

import {
	DpopProofError,
	SPACE_TOKEN_TYPES,
	SpaceTokenError,
	spaceHostAud,
	verifyDpopProof,
	verifySpaceToken,
} from "@atproto/space";
import { SpaceError } from "./errors.js";
import type { SpaceRef } from "./space-uri.js";

/** Resolve an issuer DID (+ key id) to a did:key string. */
export type GetSigningKey = (
	iss: string,
	kid: string | undefined,
	forceRefresh: boolean,
) => Promise<string>;

/** Record a single-use key; false when it was already seen. */
export type CheckReplay = (
	kind: string,
	key: string,
	expiresAtSec: number,
) => Promise<boolean>;

/**
 * Peek at an unverified JWT's `typ` header. Used only for routing between
 * authentication schemes — safe because neither token type verifies as the
 * other.
 */
export function unverifiedJwtTyp(token: string): string | null {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	try {
		const header = JSON.parse(
			atob(token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/")),
		) as { typ?: unknown };
		return typeof header.typ === "string" ? header.typ : null;
	} catch {
		return null;
	}
}

/** Whether an Authorization header carries a space credential. */
export function isSpaceCredentialAuth(authorization: string | undefined): boolean {
	if (!authorization?.startsWith("DPoP ")) return false;
	return (
		unverifiedJwtTyp(authorization.slice(5)) ===
		SPACE_TOKEN_TYPES.credential.typ
	);
}

export interface VerifyRequestOpts {
	/** HTTP method of the request. */
	htm: string;
	/** Request URL; its path is combined with `publicOrigin` for htu. */
	url: string;
	/**
	 * The origin clients see (`https://host`). The Worker may be behind a
	 * proxy, so htu is reconstructed from this rather than trusted from the
	 * incoming URL.
	 */
	publicOrigin: string;
	dpopProof: string | undefined;
	getSigningKey: GetSigningKey;
	checkReplay: CheckReplay;
}

function htuFor(opts: VerifyRequestOpts): string {
	return `${opts.publicOrigin}${new URL(opts.url).pathname}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export interface SpaceCredentialResult {
	kind: "credential";
	/** The credential issuer — the space's authority DID. */
	iss: string;
}

/**
 * Verify a space credential (`Authorization: DPoP <jwt>` + `DPoP` proof)
 * presented against `space`. Checks, per the proposal: signature against
 * the issuer's `#atproto_space` / `#atproto` key, `sub` equal to the
 * requested space, `iss` equal to the space's authority, `cnf.jkt` equal
 * to the proof key's thumbprint, proof `htm`/`htu`/`ath`/`iat` valid and
 * proof `jti` unseen.
 */
export async function verifySpaceCredentialAuth(
	credential: string,
	space: SpaceRef,
	opts: VerifyRequestOpts,
): Promise<SpaceCredentialResult> {
	let payload;
	try {
		({ payload } = await verifySpaceToken("credential", credential, {
			getSigningKey: opts.getSigningKey,
			sub: space.uri,
		}));
	} catch (err) {
		throw invalidCredential(err);
	}
	if (payload.iss !== space.authority) {
		throw new SpaceError(
			"InvalidCredential",
			"Space credential issuer is not the space authority",
		);
	}
	const jkt = payload.cnf?.jkt;
	if (!jkt) {
		throw new SpaceError(
			"InvalidCredential",
			"Space credential is missing its cnf.jkt binding",
		);
	}
	if (!opts.dpopProof) {
		throw new SpaceError("InvalidCredential", "Missing DPoP proof");
	}
	let proof;
	try {
		proof = await verifyDpopProof(opts.dpopProof, {
			htm: opts.htm,
			htu: htuFor(opts),
			credential,
			jkt,
		});
	} catch (err) {
		throw invalidCredential(err);
	}
	const fresh = await opts.checkReplay(
		"dpop",
		proof.jti,
		nowSec() + 300,
	);
	if (!fresh) {
		throw new SpaceError("InvalidCredential", "DPoP proof replayed");
	}
	return { kind: "credential", iss: payload.iss };
}

export interface DelegationResult {
	/** The user the delegation token vouches for. */
	userDid: string;
	/** Thumbprint of the DPoP key the credential must be bound to. */
	dpopJkt: string;
}

/**
 * Verify a delegation token (`Authorization: Bearer <jwt>` on
 * getSpaceCredential) plus its DPoP proof (no `ath` when obtaining a
 * credential). Single use by `(iss, jti)`.
 */
export async function verifyDelegationAuth(
	token: string,
	space: SpaceRef,
	opts: VerifyRequestOpts,
): Promise<DelegationResult> {
	let payload;
	try {
		({ payload } = await verifySpaceToken("delegation", token, {
			getSigningKey: opts.getSigningKey,
			aud: spaceHostAud(space.authority),
			sub: space.uri,
		}));
	} catch (err) {
		throw invalidDelegation(err);
	}
	if (!payload.iss.startsWith("did:")) {
		throw new SpaceError(
			"InvalidDelegationToken",
			"Delegation token issuer is not a DID",
		);
	}
	if (!opts.dpopProof) {
		throw new SpaceError("InvalidDelegationToken", "Missing DPoP proof");
	}
	let proof;
	try {
		proof = await verifyDpopProof(opts.dpopProof, {
			htm: opts.htm,
			htu: htuFor(opts),
		});
	} catch (err) {
		throw invalidDelegation(err);
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
	return { userDid: payload.iss, dpopJkt: proof.jkt };
}

function invalidCredential(err: unknown): SpaceError {
	// Server-side detail for operators; clients get the generic message.
	console.warn("space credential verification failed:", err);
	return new SpaceError("InvalidCredential", authErrorMessage(err));
}

function invalidDelegation(err: unknown): SpaceError {
	console.warn("delegation token verification failed:", err);
	return new SpaceError("InvalidDelegationToken", authErrorMessage(err));
}

function authErrorMessage(err: unknown): string {
	if (err instanceof SpaceTokenError || err instanceof DpopProofError) {
		return err.message;
	}
	// DID resolution failures and other infrastructure errors must surface
	// as 401s, never 500s — but without leaking internals.
	return "Token verification failed";
}
