/**
 * Revision (TID) helpers for the space repo.
 */

import { now as tidNow } from "@atcute/tid";

const S32_CHAR = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Next revision: a fresh TID guaranteed strictly greater than `prev`.
 * `@atcute/tid`'s clock is monotonic within an isolate, but the previous
 * rev may come from a different isolate's clock (e.g. after a DO restart),
 * so bump lexicographically when needed.
 */
export function nextRev(prev: string | null | undefined): string {
	const candidate = tidNow();
	if (!prev || candidate > prev) return candidate;
	// Increment the previous TID by one in s32 space.
	const chars = prev.split("");
	for (let i = chars.length - 1; i >= 0; i--) {
		const idx = S32_CHAR.indexOf(chars[i]!);
		if (idx < S32_CHAR.length - 1) {
			chars[i] = S32_CHAR[idx + 1]!;
			return chars.join("");
		}
		chars[i] = S32_CHAR[0]!;
	}
	// prev was the maximal TID; not reachable with real clocks.
	return candidate;
}

/**
 * The smallest TID whose timestamp is `ms` milliseconds in the past, with a
 * zero clockid. Used as a deletion cutoff for oplog compaction.
 */
export function tidCutoff(msAgo: number): string {
	const micros = BigInt(Math.max(0, Date.now() - msAgo)) * 1000n;
	// TID layout: 53 bits of microseconds followed by 10 bits of clockid,
	// encoded as 13 sortable-base32 characters.
	let value = (micros << 10n) & ((1n << 63n) - 1n);
	let out = "";
	for (let i = 12; i >= 0; i--) {
		out = S32_CHAR[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return out;
}
