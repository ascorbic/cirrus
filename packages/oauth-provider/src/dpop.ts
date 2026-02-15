/**
 * DPoP (Demonstrating Proof of Possession) verification
 * Implements RFC 9449 using jose library for JWT operations
 */

import {
	jwtVerify,
	EmbeddedJWK,
	calculateJwkThumbprint,
	errors,
	base64url,
} from "jose";
import type { JWK } from "jose";
import { randomString } from "./encoding.js";

const { JOSEError } = errors;

/**
 * Verified DPoP proof data
 */
export interface DpopProof {
	/** HTTP method from the proof */
	htm: string;
	/** HTTP URI from the proof (without query/fragment) */
	htu: string;
	/** Unique proof identifier (for replay prevention) */
	jti: string;
	/** Access token hash (if present) */
	ath?: string;
	/** Key thumbprint (JWK thumbprint of the proof key) */
	jkt: string;
	/** The public JWK from the proof */
	jwk: JWK;
}

/**
 * DPoP verification options
 */
export interface DpopVerifyOptions {
	/** Access token to verify ath claim against (optional) */
	accessToken?: string;
	/** Allowed signature algorithms (default: ['ES256']) */
	allowedAlgorithms?: string[];
	/** Expected nonce value (optional, for nonce binding) */
	expectedNonce?: string;
	/** Max token age in seconds (default: 60) */
	maxTokenAge?: number;
}

/**
 * DPoP verification error
 */
export class DpopError extends Error {
	readonly code: string;
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DpopError";
		this.code = code;
	}
}

/**
 * Normalize URI for HTU comparison
 * Removes query string and fragment per RFC 9449
 */
function normalizeHtuUrl(url: URL): string {
	return url.origin + url.pathname;
}

/**
 * Parse and validate HTU claim
 */
function parseHtu(htu: string): string {
	let url: URL;
	try {
		url = new URL(htu);
	} catch {
		throw new DpopError('DPoP "htu" is not a valid URL', "invalid_dpop");
	}

	if (url.password || url.username) {
		throw new DpopError(
			'DPoP "htu" must not contain credentials',
			"invalid_dpop",
		);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new DpopError('DPoP "htu" must be http or https', "invalid_dpop");
	}

	return normalizeHtuUrl(url);
}

/**
 * Verify a DPoP proof from a request
 * Uses jose library for JWT verification
 * @param request The HTTP request containing the DPoP header
 * @param options Verification options
 * @returns The verified proof data
 * @throws DpopError if verification fails
 */
export async function verifyDpopProof(
	request: Request,
	options: DpopVerifyOptions = {},
): Promise<DpopProof> {
	const {
		allowedAlgorithms = ["ES256"],
		accessToken,
		expectedNonce,
		maxTokenAge = 60,
	} = options;

	const dpopHeader = request.headers.get("DPoP");
	if (!dpopHeader) {
		throw new DpopError("Missing DPoP header", "missing_dpop");
	}

	let protectedHeader: { alg: string; jwk?: JWK };
	let payload: {
		jti?: string;
		htm?: string;
		htu?: string;
		iat?: number;
		ath?: string;
		nonce?: string;
	};

	try {
		const result = await jwtVerify(dpopHeader, EmbeddedJWK, {
			typ: "dpop+jwt",
			algorithms: allowedAlgorithms,
			maxTokenAge,
			clockTolerance: 10,
		});
		protectedHeader = result.protectedHeader as typeof protectedHeader;
		payload = result.payload as typeof payload;
	} catch (err) {
		if (err instanceof JOSEError) {
			throw new DpopError(
				`DPoP verification failed: ${err.message}`,
				"invalid_dpop",
				{ cause: err },
			);
		}
		throw new DpopError("DPoP verification failed", "invalid_dpop", {
			cause: err,
		});
	}

	if (!payload.jti || typeof payload.jti !== "string") {
		throw new DpopError('DPoP "jti" missing', "invalid_dpop");
	}

	if (!payload.htm || typeof payload.htm !== "string") {
		throw new DpopError('DPoP "htm" missing', "invalid_dpop");
	}

	if (!payload.htu || typeof payload.htu !== "string") {
		throw new DpopError('DPoP "htu" missing', "invalid_dpop");
	}

	if (payload.htm !== request.method) {
		throw new DpopError('DPoP "htm" mismatch', "invalid_dpop");
	}

	const requestUrl = new URL(request.url);
	const expectedHtu = normalizeHtuUrl(requestUrl);
	const proofHtu = parseHtu(payload.htu);
	if (proofHtu !== expectedHtu) {
		throw new DpopError('DPoP "htu" mismatch', "invalid_dpop");
	}

	if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
		throw new DpopError('DPoP "nonce" mismatch', "use_dpop_nonce");
	}

	// Verify ath (access token hash) binding per RFC 9449 Section 4.3
	if (accessToken) {
		if (!payload.ath) {
			throw new DpopError(
				'DPoP "ath" missing when access token provided',
				"invalid_dpop",
			);
		}

		const tokenHash = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(accessToken),
		);
		const expectedAth = base64url.encode(new Uint8Array(tokenHash));

		if (payload.ath !== expectedAth) {
			throw new DpopError('DPoP "ath" mismatch', "invalid_dpop");
		}
	} else if (payload.ath !== undefined) {
		throw new DpopError(
			'DPoP "ath" claim not allowed without access token',
			"invalid_dpop",
		);
	}

	const jwk = protectedHeader.jwk!;
	const jkt = await calculateJwkThumbprint(jwk, "sha256");

	return Object.freeze({
		htm: payload.htm,
		htu: payload.htu,
		jti: payload.jti,
		ath: payload.ath,
		jkt,
		jwk,
	});
}

/**
 * Generate a random DPoP nonce
 * @returns A base64url-encoded random nonce (16 bytes)
 */
export function generateDpopNonce(): string {
	return randomString(16);
}
