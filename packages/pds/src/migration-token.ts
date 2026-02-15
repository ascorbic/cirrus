/**
 * Stateless migration tokens for outbound account migration
 *
 * Uses HMAC-SHA256 to create tokens that encode the DID and expiry time.
 * No database storage required - validity is verified by the signature.
 *
 * Token format: base64url(payload).base64url(signature)
 * Payload: {"did":"did:plc:xxx","exp":1736600000}
 *
 * Tokens expire after 15 minutes - enough time to complete the migration
 * process but short enough to limit exposure if the token is leaked.
 */

import { base64url } from "jose";

const MINUTE = 60 * 1000;
const TOKEN_EXPIRY = 15 * MINUTE; // 15 minutes

interface TokenPayload {
	did: string;
	exp: number;
}

/**
 * Create an HMAC-SHA256 signature
 */
async function hmacSign(data: string, secret: string): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

/**
 * Verify an HMAC-SHA256 signature
 */
async function hmacVerify(
	data: string,
	signature: ArrayBuffer,
	secret: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, signature, encoder.encode(data));
}

/**
 * Create a migration token for outbound migration
 *
 * @param did - The user's DID
 * @param jwtSecret - The JWT_SECRET used for signing
 * @returns A stateless, signed token
 */
export async function createMigrationToken(
	did: string,
	jwtSecret: string,
): Promise<string> {
	const exp = Math.floor((Date.now() + TOKEN_EXPIRY) / 1000);
	const payload: TokenPayload = { did, exp };

	const payloadStr = JSON.stringify(payload);
	const payloadB64 = base64url.encode(new TextEncoder().encode(payloadStr));

	const signature = await hmacSign(payloadB64, jwtSecret);
	const signatureB64 = base64url.encode(new Uint8Array(signature));

	return `${payloadB64}.${signatureB64}`;
}

/**
 * Validate a migration token
 *
 * @param token - The token to validate
 * @param expectedDid - The expected DID (must match token payload)
 * @param jwtSecret - The JWT_SECRET used for verification
 * @returns The payload if valid, null if invalid/expired
 */
export async function validateMigrationToken(
	token: string,
	expectedDid: string,
	jwtSecret: string,
): Promise<TokenPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return null;
	}

	const [payloadB64, signatureB64] = parts as [string, string];

	try {
		// Verify signature
		const signatureBytes = base64url.decode(signatureB64);
		const isValid = await hmacVerify(
			payloadB64,
			signatureBytes.buffer,
			jwtSecret,
		);
		if (!isValid) {
			return null;
		}

		// Decode and validate payload
		const payloadStr = new TextDecoder().decode(base64url.decode(payloadB64));
		const payload: TokenPayload = JSON.parse(payloadStr);

		// Check DID matches
		if (payload.did !== expectedDid) {
			return null;
		}

		// Check expiry
		const now = Math.floor(Date.now() / 1000);
		if (payload.exp < now) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}
