/**
 * Test helpers for DPoP and PKCE
 * These are client-side functions that shouldn't be in the production package
 */

import { base64url } from "jose";

// ============================================
// DPoP Test Helpers
// ============================================

/**
 * JWA algorithm to Web Crypto parameter mapping
 */
const ALGORITHM_PARAMS = {
	ES256: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" },
	ES384: { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" },
	ES512: { name: "ECDSA", namedCurve: "P-521", hash: "SHA-512" },
	RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	RS384: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
	RS512: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
} as const;

function getAlgorithmParams(alg: string) {
	if (alg in ALGORITHM_PARAMS) {
		return ALGORITHM_PARAMS[alg as keyof typeof ALGORITHM_PARAMS];
	}
	return null;
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
		jti: base64url.encode(crypto.getRandomValues(new Uint8Array(16))),
		htm: claims.htm,
		htu: claims.htu,
		iat: Math.floor(Date.now() / 1000),
		...(claims.ath && { ath: claims.ath }),
		...(claims.nonce && { nonce: claims.nonce }),
	};

	const headerB64 = base64url.encode(new TextEncoder().encode(JSON.stringify(header)));
	const payloadB64 = base64url.encode(new TextEncoder().encode(JSON.stringify(payload)));

	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const params = getAlgorithmParams(alg);
	if (!params) {
		throw new Error(`Unsupported algorithm: ${alg}`);
	}

	const signParams =
		params.name === "ECDSA" ? { name: params.name, hash: params.hash } : { name: params.name };

	const signature = await crypto.subtle.sign(signParams, privateKey, data);
	const signatureB64 = base64url.encode(new Uint8Array(signature));

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

	const generateParams =
		params.name === "ECDSA"
			? { name: params.name, namedCurve: params.namedCurve! }
			: {
					name: params.name,
					modulusLength: 2048,
					publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
					hash: params.hash,
				};

	const keyPair = (await crypto.subtle.generateKey(generateParams, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;

	const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

	// Remove optional fields that shouldn't be in the proof
	delete publicJwk.key_ops;
	delete publicJwk.ext;

	return {
		privateKey: keyPair.privateKey,
		publicKey: keyPair.publicKey,
		publicJwk,
	};
}

// ============================================
// PKCE Test Helpers
// ============================================

/**
 * Generate a cryptographically random code verifier
 * @returns A random code verifier (64 characters)
 */
export function generateCodeVerifier(): string {
	// 48 bytes = 64 base64url characters
	const bytes = crypto.getRandomValues(new Uint8Array(48));
	return base64url.encode(bytes);
}

/**
 * Generate the S256 code challenge from a verifier
 * challenge = BASE64URL(SHA256(verifier))
 * @param verifier The code verifier
 * @returns The code challenge
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return base64url.encode(new Uint8Array(hash));
}
