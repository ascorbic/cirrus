/**
 * Just enough CARv1 reading to assert getRepo's declared shape: the
 * lexicon requires exactly two roots (the signed commit, then the index).
 * Reading the header needs only a varint and a dag-cbor decode — no CAR
 * library, no node streams — so it stays runnable anywhere the full entry
 * runs.
 */

import { decode as cborDecode } from "@atproto/lex-cbor";

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
	let result = 0;
	let shift = 0;
	let pos = offset;
	for (;;) {
		const byte = bytes[pos];
		if (byte === undefined) throw new Error("truncated varint");
		result |= (byte & 0x7f) << shift;
		pos += 1;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}
	return [result, pos];
}

interface CarHeaderInfo {
	version: number;
	rootCount: number;
}

/** Parse just the CARv1 header block and report its version and root count. */
export function readCarHeader(bytes: Uint8Array): CarHeaderInfo {
	const [headerLen, afterVarint] = readVarint(bytes, 0);
	const headerBytes = bytes.subarray(afterVarint, afterVarint + headerLen);
	const header = cborDecode(headerBytes) as {
		version?: number;
		roots?: unknown[];
	};
	return {
		version: header.version ?? 0,
		rootCount: Array.isArray(header.roots) ? header.roots.length : 0,
	};
}
