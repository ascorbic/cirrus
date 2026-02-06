/**
 * Farcaster Quick Auth verification module.
 *
 * Farcaster Quick Auth is an official lightweight auth service built on
 * Sign In with Farcaster (SIWF). It returns a JWT with the user's FID
 * in the `sub` claim.
 *
 * @see https://www.npmjs.com/package/@farcaster/quick-auth
 */

import { createClient, type QuickAuthClient } from "@farcaster/quick-auth";

/** Cached Quick Auth client instance */
let quickAuthClient: QuickAuthClient | null = null;

/**
 * Get or create the Quick Auth client.
 */
function getQuickAuthClient(): QuickAuthClient {
	if (!quickAuthClient) {
		quickAuthClient = createClient();
	}
	return quickAuthClient;
}

/**
 * Verify a Farcaster Quick Auth JWT and extract the FID.
 *
 * @param token - The Quick Auth JWT from the client
 * @param domain - The expected domain (e.g., "fid.is")
 * @returns The verified FID as a string
 * @throws Error if verification fails or FID is invalid
 */
export async function verifyQuickAuthToken(
	token: string,
	domain: string,
): Promise<string> {
	const client = getQuickAuthClient();

	// Verify the JWT - this validates signature and expiration
	const payload = await client.verifyJwt({ token, domain });

	// Extract FID from the `sub` claim (it's a string in the JWT)
	const fid = payload.sub;
	if (!fid) {
		throw new Error("Quick Auth JWT missing 'sub' claim");
	}

	// Validate it's a positive integer string (no leading zeros, not "0")
	if (!/^[1-9]\d*$/.test(fid)) {
		throw new Error(`Invalid FID in Quick Auth JWT: ${fid}`);
	}

	return fid;
}

/**
 * FID-based identity derivation utilities.
 * These mappings are deterministic - no database lookup needed.
 */

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive DID from FID.
 * @example fidToDid("123", "fid.is") => "did:web:123.fid.is"
 */
export function fidToDid(fid: string, domain: string): string {
	return `did:web:${fid}.${domain}`;
}

/**
 * Derive the initial handle from FID.
 *
 * Note: This returns the default handle assigned at account creation.
 * Users can change their handle to any DNS name they control, so you
 * cannot reliably derive FID from an arbitrary handle.
 *
 * @example fidToHandle("123", "fid.is") => "123.fid.is"
 */
export function fidToHandle(fid: string, domain: string): string {
	return `${fid}.${domain}`;
}

/**
 * Extract FID from DID.
 * @example didToFid("did:web:123.fid.is", "fid.is") => "123"
 * @returns Valid FID string or null if DID doesn't match expected format
 */
export function didToFid(did: string, domain: string): string | null {
	// Regex matches positive integers only:
	// - [1-9] first digit must be 1-9 (rejects "0" and leading zeros like "0123")
	// - \d* followed by zero or more digits
	const regex = new RegExp(`^did:web:([1-9]\\d*)\\.${escapeRegex(domain)}$`);
	const match = did.match(regex);
	if (!match || !match[1]) return null;
	return match[1];
}

/**
 * Extract FID from a subdomain hostname.
 *
 * This checks if a hostname matches the pattern `NNN.{domain}` where NNN is
 * a numeric FID. Used for routing requests on per-user subdomains.
 *
 * Note: This is for hostnames (URLs), not handles. Handles can be changed
 * by users to any DNS name, so handle -> FID extraction is not reliable.
 *
 * @example hostnameToFid("123.fid.is", "fid.is") => "123"
 * @example hostnameToFid("alice.example.com", "fid.is") => null
 * @returns FID string or null if hostname doesn't match the subdomain pattern
 */
export function hostnameToFid(hostname: string, domain: string): string | null {
	// Regex matches positive integers only:
	// - [1-9] first digit must be 1-9 (rejects "0" and leading zeros like "0123")
	// - \d* followed by zero or more digits
	const regex = new RegExp(`^([1-9]\\d*)\\.${escapeRegex(domain)}$`);
	const match = hostname.match(regex);
	if (!match || !match[1]) return null;
	return match[1];
}
