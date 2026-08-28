/**
 * Space URI handling.
 *
 * A space is addressed as `at://{authorityDid}/space/{typeNsid}/{skey}` —
 * the literal `space` marker keeps it unambiguous with public record URIs
 * because a collection NSID always contains at least two dots. A record in
 * a space appends `/{authorDid}/{collection}/{rkey}`.
 */

import { isDid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import { SpaceError } from "./errors.js";

export interface SpaceRef {
	/** The full space URI. */
	uri: string;
	/** The space authority DID. */
	authority: string;
	/** The space type NSID. */
	type: string;
	/** The space key (record-key syntax). */
	skey: string;
}

/**
 * Parse a space URI. Returns null when the string is not a valid space
 * reference.
 */
export function parseSpaceUri(uri: string): SpaceRef | null {
	if (!uri.startsWith("at://")) return null;
	const parts = uri.slice("at://".length).split("/");
	if (parts.length !== 4) return null;
	const [authority, marker, type, skey] = parts as [
		string,
		string,
		string,
		string,
	];
	if (marker !== "space") return null;
	if (!isDid(authority) || !isNsid(type) || !isRecordKey(skey)) return null;
	const ref = { uri: formatSpaceUri(authority, type, skey), authority, type, skey };
	// Round-trip requirement mirrors the reference's SpaceRef.parse.
	if (ref.uri !== uri) return null;
	return ref;
}

/** Parse a space URI or throw an InvalidSpaceUri error. */
export function requireSpaceUri(uri: string | undefined): SpaceRef {
	const ref = uri ? parseSpaceUri(uri) : null;
	if (!ref) {
		throw new SpaceError("InvalidSpaceUri", `Invalid space URI: ${uri}`);
	}
	return ref;
}

export function formatSpaceUri(
	authority: string,
	type: string,
	skey: string,
): string {
	return `at://${authority}/space/${type}/${skey}`;
}

/** URI of a record within a space: `{spaceUri}/{repoDid}/{collection}/{rkey}`. */
export function spaceRecordUri(
	spaceUri: string,
	repo: string,
	collection: string,
	rkey: string,
): string {
	return `${spaceUri}/${repo}/${collection}/${rkey}`;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Stable identifier for a space used in R2 key prefixes: the lowercase,
 * unpadded base32 encoding of the SHA-256 of the space URI. Deterministic,
 * filesystem-safe and free of the URI's slashes and colons.
 */
export async function spaceId(spaceUri: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spaceUri)),
	);
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of digest) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return out;
}
