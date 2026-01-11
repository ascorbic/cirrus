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
 * Encode bytes to base64url
 */
function toBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Decode base64url to bytes
 */
function fromBase64Url(str: string): Uint8Array {
	const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
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
	const payloadBytes = new TextEncoder().encode(payloadStr);
	const payloadB64 = toBase64Url(payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength) as ArrayBuffer);

	const signature = await hmacSign(payloadB64, jwtSecret);
	const signatureB64 = toBase64Url(signature);

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

	// Verify signature
	const signatureBytes = fromBase64Url(signatureB64);
	const signatureBuffer = signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer;
	const isValid = await hmacVerify(payloadB64, signatureBuffer, jwtSecret);
	if (!isValid) {
		return null;
	}

	// Decode and validate payload
	try {
		const payloadStr = new TextDecoder().decode(fromBase64Url(payloadB64));
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
