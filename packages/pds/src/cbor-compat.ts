/**
 * CBOR compatibility layer for migrating from @atproto/lex-cbor to @atcute/cbor.
 *
 * @atcute/cbor uses lazy wrappers (BytesWrapper, CidLinkWrapper) that are
 * compatible with atproto's lex-json format. This layer handles conversion
 * of @atproto CID objects to CidLinkWrapper for encoding.
 *
 * Use toCidLink/fromCidLink to convert between lex-json and raw CID types.
 */
import {
	encode as atcuteEncode,
	decode as atcuteDecode,
	toCidLink,
	toBytes,
	fromBytes,
	isBytes,
	type CidLink,
} from "@atcute/cbor";
import { fromString } from "@atcute/cid";
import type { CID } from "@atproto/lex-data";

/**
 * Check if a value is an @atproto CID object.
 */
function isAtprotoCid(value: unknown): value is CID {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string | symbol, unknown>;
	return "asCID" in obj && obj[Symbol.toStringTag] === "CID";
}

/**
 * Convert @atproto CID to @atcute CidLink.
 */
function atprotoCidToCidLink(cid: CID): CidLink {
	return toCidLink(fromString(cid.toString()));
}

/**
 * Recursively convert @atproto CIDs to @atcute CidLinks for encoding.
 */
function convertCidsForEncode(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value !== "object") {
		return value;
	}

	// Handle Uint8Array - wrap with toBytes() for @atcute/cbor
	if (ArrayBuffer.isView(value) && value instanceof Uint8Array) {
		return toBytes(value);
	}

	// Convert @atproto CID to @atcute CidLink
	if (isAtprotoCid(value)) {
		return atprotoCidToCidLink(value);
	}

	// Handle arrays
	if (Array.isArray(value)) {
		return value.map(convertCidsForEncode);
	}

	// Handle plain objects
	const obj = value as object;
	if (obj.constructor === Object) {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(obj)) {
			result[key] = convertCidsForEncode(val);
		}
		return result;
	}

	return value;
}

/**
 * Encode a value to CBOR, automatically converting @atproto CIDs to CidLinks.
 *
 * Decoded values will contain CidLinkWrapper objects which have a lazy $link
 * getter returning the CID string - compatible with lex-json format.
 */
export function encode(value: unknown): Uint8Array {
	const converted = convertCidsForEncode(value);
	return atcuteEncode(converted);
}

/**
 * Recursively convert @atcute wrappers back to raw types for decoding.
 */
function convertWrappersForDecode(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value !== "object") {
		return value;
	}

	// Unwrap BytesWrapper to raw Uint8Array
	if (isBytes(value)) {
		return fromBytes(value);
	}

	// CidLinkWrapper is left as-is since it has $link getter for lex-json compat

	// Handle arrays
	if (Array.isArray(value)) {
		return value.map(convertWrappersForDecode);
	}

	// Handle plain objects
	const obj = value as object;
	if (obj.constructor === Object) {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(obj)) {
			result[key] = convertWrappersForDecode(val);
		}
		return result;
	}

	return value;
}

/**
 * Decode CBOR bytes.
 *
 * Unwraps BytesWrapper to raw Uint8Array for compatibility.
 * CidLinkWrapper is left as-is (access via .$link for lex-json compat).
 */
export function decode(bytes: Uint8Array): unknown {
	const decoded = atcuteDecode(bytes);
	return convertWrappersForDecode(decoded);
}
