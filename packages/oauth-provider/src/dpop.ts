/**
 * DPoP (Demonstrating Proof of Possession) verification
 * Implements RFC 9449 using jose library for JWT operations
 */

import { jwtVerify, EmbeddedJWK, calculateJwkThumbprint, errors } from "jose";
import type { JWK } from "jose";
import { base64UrlEncode, randomString } from "./encoding.js";

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
	constructor(
		message: string,
		public readonly code: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = "DpopError";
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
		throw new DpopError('DPoP "htu" must not contain credentials', "invalid_dpop");
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
	options: DpopVerifyOptions = {}
): Promise<DpopProof> {
	const { allowedAlgorithms = ["ES256"], accessToken, expectedNonce, maxTokenAge = 60 } = options;

	// 1. Get DPoP header
	const dpopHeader = request.headers.get("DPoP");
	if (!dpopHeader) {
		throw new DpopError("Missing DPoP header", "missing_dpop");
	}

	// 2. Verify JWT using jose with EmbeddedJWK
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
			maxTokenAge, // Validates iat claim
			clockTolerance: 10, // 10 seconds clock tolerance
		});
		protectedHeader = result.protectedHeader as typeof protectedHeader;
		payload = result.payload as typeof payload;
	} catch (err) {
		if (err instanceof JOSEError) {
			throw new DpopError(`DPoP verification failed: ${err.message}`, "invalid_dpop", err);
		}
		throw new DpopError("DPoP verification failed", "invalid_dpop", err);
	}

	// 3. Validate required claims
	if (!payload.jti || typeof payload.jti !== "string") {
		throw new DpopError('DPoP "jti" missing', "invalid_dpop");
	}

	if (!payload.htm || typeof payload.htm !== "string") {
		throw new DpopError('DPoP "htm" missing', "invalid_dpop");
	}

	if (!payload.htu || typeof payload.htu !== "string") {
		throw new DpopError('DPoP "htu" missing', "invalid_dpop");
	}

	// 4. Verify htm matches request method (case-sensitive per RFC 9110)
	if (payload.htm !== request.method) {
		throw new DpopError('DPoP "htm" mismatch', "invalid_dpop");
	}

	// 5. Verify htu matches request URL (normalized, without query/fragment)
	const requestUrl = new URL(request.url);
	const expectedHtu = normalizeHtuUrl(requestUrl);
	const proofHtu = parseHtu(payload.htu);
	if (proofHtu !== expectedHtu) {
		throw new DpopError('DPoP "htu" mismatch', "invalid_dpop");
	}

	// 6. Verify nonce if expected
	if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
		throw new DpopError('DPoP "nonce" mismatch', "use_dpop_nonce");
	}

	// 7. Verify ath (access token hash) if access token provided
	if (accessToken) {
		if (!payload.ath) {
			throw new DpopError('DPoP "ath" missing when access token provided', "invalid_dpop");
		}

		const tokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
		const expectedAth = base64UrlEncode(tokenHash);

		if (payload.ath !== expectedAth) {
			throw new DpopError('DPoP "ath" mismatch', "invalid_dpop");
		}
	} else if (payload.ath !== undefined) {
		throw new DpopError('DPoP "ath" claim not allowed without access token', "invalid_dpop");
	}

	// 8. Get JWK from header (guaranteed to exist after EmbeddedJWK verification)
	const jwk = protectedHeader.jwk!;

	// 9. Calculate key thumbprint using jose
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

// ============================================
// Test Helpers (using Web Crypto directly)
// ============================================

/**
 * Map JWA algorithm names to Web Crypto parameters
 */
function getAlgorithmParams(
	alg: string
): { name: string; namedCurve?: string; hash?: string } | null {
	switch (alg) {
		case "ES256":
			return { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
		case "ES384":
			return { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" };
		case "ES512":
			return { name: "ECDSA", namedCurve: "P-521", hash: "SHA-512" };
		case "RS256":
			return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
		case "RS384":
			return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
		case "RS512":
			return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" };
		default:
			return null;
	}
}

/**
 * Create a DPoP proof JWT for testing
 * @param privateKey The signing key (CryptoKey)
 * @param publicJwk The public JWK to include in the header
 * @param claims The DPoP claims
 * @param alg The algorithm (default: ES256)
 * @returns The signed DPoP JWT
 */
export async function createDpopProof(
	privateKey: CryptoKey,
	publicJwk: JsonWebKey,
	claims: { htm: string; htu: string; ath?: string; nonce?: string },
	alg: string = "ES256"
): Promise<string> {
	const header = {
		typ: "dpop+jwt",
		alg,
		jwk: publicJwk,
	};

	const payload = {
		jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)).buffer),
		htm: claims.htm,
		htu: claims.htu,
		iat: Math.floor(Date.now() / 1000),
		...(claims.ath && { ath: claims.ath }),
		...(claims.nonce && { nonce: claims.nonce }),
	};

	const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));

	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const params = getAlgorithmParams(alg);
	if (!params) {
		throw new Error(`Unsupported algorithm: ${alg}`);
	}

	const signParams =
		params.name === "ECDSA" ? { name: params.name, hash: params.hash! } : { name: params.name };

	const signature = await crypto.subtle.sign(signParams, privateKey, data);
	const signatureB64 = base64UrlEncode(signature);

	return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Generate a key pair for DPoP testing
 * @param alg The algorithm (default: ES256)
 * @returns The key pair and public JWK
 */
export async function generateDpopKeyPair(
	alg: string = "ES256"
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey }> {
	const params = getAlgorithmParams(alg);
	if (!params) {
		throw new Error(`Unsupported algorithm: ${alg}`);
	}

	const generateParams: EcKeyGenParams | RsaHashedKeyGenParams =
		params.name === "ECDSA"
			? { name: params.name, namedCurve: params.namedCurve! }
			: {
					name: params.name,
					modulusLength: 2048,
					publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
					hash: params.hash!,
				};

	const keyPair = await crypto.subtle.generateKey(generateParams, true, ["sign", "verify"]);

	const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

	// Remove optional fields that shouldn't be in the proof
	delete publicJwk.key_ops;
	delete publicJwk.ext;

	return {
		privateKey: keyPair.privateKey,
		publicKey: keyPair.publicKey,
		publicJwk,
	};
}

/**
 * Calculate JWK thumbprint (wrapper around jose for backwards compatibility)
 */
export async function calculateKeyThumbprint(jwk: JsonWebKey): Promise<string> {
	return calculateJwkThumbprint(jwk as JWK, "sha256");
}
