/**
 * PKCE (Proof Key for Code Exchange) verification
 * Implements RFC 7636 with S256 challenge method
 */

/**
 * Base64URL encode without padding
 */
function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
	return base64UrlEncode(hash);
}

/**
 * Verify a PKCE code challenge against a verifier
 * @param verifier The code verifier from the token request
 * @param challenge The code challenge from the authorization request
 * @param method The challenge method (only S256 supported for AT Protocol)
 * @returns true if the verifier matches the challenge
 */
export async function verifyPkceChallenge(
	verifier: string,
	challenge: string,
	method: "S256"
): Promise<boolean> {
	if (method !== "S256") {
		throw new Error("Only S256 challenge method is supported");
	}

	// Validate verifier format (RFC 7636 Section 4.1)
	// Must be 43-128 characters, unreserved characters only
	if (verifier.length < 43 || verifier.length > 128) {
		return false;
	}
	if (!/^[A-Za-z0-9._~-]+$/.test(verifier)) {
		return false;
	}

	const expectedChallenge = await generateCodeChallenge(verifier);
	return expectedChallenge === challenge;
}

/**
 * Generate a cryptographically random code verifier
 * @returns A random code verifier (64 characters)
 */
export function generateCodeVerifier(): string {
	const bytes = new Uint8Array(48); // 48 bytes = 64 base64url characters
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes.buffer);
}
