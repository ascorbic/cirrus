/**
 * Shared encoding utilities for OAuth provider
 */

/**
 * Base64URL encode without padding (RFC 4648 Section 5)
 *
 * Used for encoding tokens, PKCE challenges, and DPoP proofs.
 *
 * @param buffer The ArrayBuffer to encode
 * @returns Base64URL-encoded string without padding
 */
export function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a cryptographically random string
 *
 * @param byteLength Number of random bytes (default: 32 = 256 bits)
 * @returns Base64URL-encoded random string
 */
export function randomString(byteLength: number = 32): string {
	const buffer = new Uint8Array(byteLength);
	crypto.getRandomValues(buffer);
	return base64UrlEncode(buffer.buffer);
}
