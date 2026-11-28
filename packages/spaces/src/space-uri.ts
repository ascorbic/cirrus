/**
 * Space URI handling.
 *
 * A space is addressed as `at:space/{authorityDid}/{typeNsid}/{skey}`, and a
 * record in a space appends `/{authorDid}/{collection}/{rkey}`. The
 * `at:space/` prefix tells it apart from a public `at://` URI.
 *
 * Params are parsed strictly: the alpha's earlier `at://{did}/space/...`
 * form is refused, as the reference refuses it. Only record values written
 * during the alpha may still carry it, and the engine never parses those.
 */

/** The prefix of every space URI. */
export const SPACE_URI_PREFIX = "at:space/";

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
	if (!uri.startsWith(SPACE_URI_PREFIX)) return null;
	const parts = uri.slice(SPACE_URI_PREFIX.length).split("/");
	if (parts.length !== 3) return null;
	const [authority, type, skey] = parts as [string, string, string];
	if (!isDid(authority) || !isNsid(type) || !isRecordKey(skey)) return null;
	const ref = {
		uri: formatSpaceUri(authority, type, skey),
		authority,
		type,
		skey,
	};
	// Round-trip requirement mirrors the reference's SpaceRef.parse.
	if (ref.uri !== uri) return null;
	return ref;
}

/**
 * Parse a space URI or throw. The error is XRPC's generic InvalidRequest, as
 * the reference answers: no lexicon declares a more specific one.
 */
export function requireSpaceUri(uri: string | undefined): SpaceRef {
	const ref = uri ? parseSpaceUri(uri) : null;
	if (!ref) {
		throw new SpaceError("InvalidRequest", `Invalid space URI: ${uri}`);
	}
	return ref;
}

export function formatSpaceUri(
	authority: string,
	type: string,
	skey: string,
): string {
	return `${SPACE_URI_PREFIX}${authority}/${type}/${skey}`;
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
