/**
 * Dependency-free byte encodings shared by the browser-safe helpers:
 * base64 (padded, unpadded and url-safe), base58btc for did:key, base32
 * for CIDs, and a few byte utilities. Kept here so the browser catalog
 * never pulls a multiformats or noble dependency for a dozen lines of code.
 */

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export const toBase64Url = (bytes: Uint8Array): string =>
	toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Decode base64 or base64url, padded or not. */
function fromBase64(input: string): Uint8Array {
	let s = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	s = s.padEnd(Math.ceil(s.length / 4) * 4, "=");
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
	let n = 0n;
	for (const b of bytes) n = n * 256n + BigInt(b);
	let out = "";
	while (n > 0n) {
		out = B58[Number(n % 58n)] + out;
		n /= 58n;
	}
	return "1".repeat(zeros) + out;
}

export function fromBase58(input: string): Uint8Array {
	let zeros = 0;
	while (zeros < input.length && input[zeros] === "1") zeros++;
	let n = 0n;
	for (const ch of input) {
		const value = B58.indexOf(ch);
		if (value < 0) throw new Error(`invalid base58 character: ${ch}`);
		n = n * 58n + BigInt(value);
	}
	const body: number[] = [];
	while (n > 0n) {
		body.unshift(Number(n % 256n));
		n /= 256n;
	}
	return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function toBase32(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

/** A CIDv1 (raw codec, sha2-256) for some bytes — a well-formed blob CID. */
export async function rawCid(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", bytes as BufferSource),
	);
	// version 1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes
	return `b${toBase32(concatBytes([new Uint8Array([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", bytes as BufferSource),
	);
}

/** Decode a compact JWT's header and payload without verifying it. */
export function decodeJwt(jwt: string): {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
} {
	const parts = jwt.split(".");
	if (parts.length !== 3) throw new Error("not a compact JWT");
	const decode = (part: string) =>
		JSON.parse(new TextDecoder().decode(fromBase64(part))) as Record<
			string,
			unknown
		>;
	return { header: decode(parts[0]!), payload: decode(parts[1]!) };
}

/** `$bytes` JSON wire form → bytes, or undefined if it isn't one. */
export function lexBytes(value: unknown): Uint8Array | undefined {
	if (
		value &&
		typeof value === "object" &&
		typeof (value as { $bytes?: unknown }).$bytes === "string"
	) {
		return fromBase64((value as { $bytes: string }).$bytes);
	}
	return undefined;
}

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export const isTid = (value: unknown): value is string =>
	typeof value === "string" && TID_RE.test(value);

/** A TID for a given time in microseconds since the epoch (clock id 0). */
export function tidAt(micros: bigint): string {
	let n = (micros << 10n) & 0x7fffffffffffffffn;
	let out = "";
	for (let i = 0; i < 13; i++) {
		out = TID_CHARS[Number(n & 31n)] + out;
		n >>= 5n;
	}
	return out;
}

export const tidNow = (): string => tidAt(BigInt(Date.now()) * 1000n);
