/**
 * Shared encoding utilities for OAuth provider
 *
 * Uses jose's base64url utilities which are well-tested and maintained.
 */

import { base64url } from "jose";

/**
 * Base64URL encode without padding (RFC 4648 Section 5)
 *
 * Used for encoding tokens, PKCE challenges, and DPoP proofs.
 *
 * @param buffer The ArrayBuffer or Uint8Array to encode
 * @returns Base64URL-encoded string without padding
 */
export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return base64url.encode(bytes);
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
	return base64url.encode(buffer);
}
