/**
 * Browser-safe space credential presentation: P-256 did:key credential
 * keys, the `atproto-space-credential` HTTP message signature, and the
 * KEM key share a syncer sends in `Atproto-Space-Want-Mac`.
 *
 * Deliberately dependency-free (WebCrypto and BigInt only) so the checks
 * that present a credential — the operator's own credential flow, the MAC
 * and signature refusals — run in a browser bundle too. Every format here
 * mirrors `@atproto/space` byte for byte (`createSpaceSigHeaders`,
 * `encapsulate`, `formatWantMacHeader`); the full test suite cross-checks
 * each against the reference library, so a drift fails CI rather than
 * every run against a real host.
 *
 * Verifying a MAC (rather than requesting one) needs the reference
 * library's commit and record encodings, so it lives behind the full
 * entry.
 */

import {
	concatBytes,
	fromBase58,
	fromBase64,
	toBase58,
	toBase64,
	utf8,
} from "./encoding.js";

// --- P-256 points ------------------------------------------------------

const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const P256_MULTICODEC = new Uint8Array([0x80, 0x24]); // p256-pub, varint
const K256_MULTICODEC = new Uint8Array([0xe7, 0x01]); // secp256k1-pub, varint

function bytesToBigInt(bytes: Uint8Array): bigint {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	return n;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--) {
		out[i] = Number(n & 0xffn);
		n >>= 8n;
	}
	return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
	let result = 1n;
	base %= mod;
	while (exp > 0n) {
		if (exp & 1n) result = (result * base) % mod;
		base = (base * base) % mod;
		exp >>= 1n;
	}
	return result;
}

/** 0x04 || x || y → 0x02/0x03 || x. Curve-agnostic (secp256k1 too). */
export function compressP256(uncompressed: Uint8Array): Uint8Array {
	if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
		throw new Error("expected an uncompressed EC point");
	}
	const prefix = (uncompressed[64]! & 1) === 1 ? 0x03 : 0x02;
	return concatBytes([new Uint8Array([prefix]), uncompressed.subarray(1, 33)]);
}

/** 0x02/0x03 || x → 0x04 || x || y. */
export function decompressP256(compressed: Uint8Array): Uint8Array {
	if (
		compressed.length !== 33 ||
		(compressed[0] !== 2 && compressed[0] !== 3)
	) {
		throw new Error("expected a compressed P-256 point");
	}
	const x = bytesToBigInt(compressed.subarray(1));
	const rhs = (((x * x * x - 3n * x + B) % P) + P) % P;
	// P ≡ 3 (mod 4), so the square root is rhs^((P+1)/4).
	let y = modPow(rhs, (P + 1n) / 4n, P);
	if ((y * y) % P !== rhs) throw new Error("point is not on P-256");
	if ((y & 1n) !== BigInt(compressed[0]! & 1)) y = P - y;
	return concatBytes([
		new Uint8Array([0x04]),
		bigIntToBytes(x, 32),
		bigIntToBytes(y, 32),
	]);
}

export type DidKeyAlg = "ES256" | "ES256K";

/** Format a did:key from a public key (compressed or, for P-256, not). */
export function formatDidKey(alg: DidKeyAlg, keyBytes: Uint8Array): string {
	if (alg === "ES256") {
		const compressed =
			keyBytes.length === 65 ? compressP256(keyBytes) : keyBytes;
		return `did:key:z${toBase58(concatBytes([P256_MULTICODEC, compressed]))}`;
	}
	if (keyBytes.length !== 33) {
		throw new Error("secp256k1 keys must be given compressed");
	}
	return `did:key:z${toBase58(concatBytes([K256_MULTICODEC, keyBytes]))}`;
}

/** Parse a did:key, returning its algorithm and compressed key bytes. */
export function parseDidKey(didKey: string): {
	alg: DidKeyAlg;
	compressed: Uint8Array;
} {
	if (!didKey.startsWith("did:key:z")) throw new Error("not a did:key");
	const bytes = fromBase58(didKey.slice("did:key:z".length));
	if (bytes[0] === 0x80 && bytes[1] === 0x24) {
		return { alg: "ES256", compressed: bytes.subarray(2) };
	}
	if (bytes[0] === 0xe7 && bytes[1] === 0x01) {
		return { alg: "ES256K", compressed: bytes.subarray(2) };
	}
	throw new Error("unsupported did:key type");
}

export function isP256DidKey(value: unknown): boolean {
	try {
		return typeof value === "string" && parseDidKey(value).alg === "ES256";
	} catch {
		return false;
	}
}

// --- credential keys ---------------------------------------------------

/**
 * A P-256 key a space credential is bound to (its `cnf.kid`). Each request
 * presenting the credential is signed by it. Transport-owned: any fresh
 * key will do, so it is never tied to a harness identity.
 */
export interface CredentialKey {
	/** The key as a P-256 did:key — what `credentialKid` carries. */
	did: string;
	/** Sign with ECDSA P-256/SHA-256, returning a 64-byte compact signature. */
	sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export async function createCredentialKey(): Promise<CredentialKey> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign"],
	);
	const raw = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	return {
		did: formatDidKey("ES256", raw),
		async sign(bytes) {
			const sig = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					pair.privateKey,
					bytes as BufferSource,
				),
			);
			// WebCrypto does not normalise s. Verifiers accept either form, but
			// low-S is the conservative choice for a key every host must accept.
			const s = bytesToBigInt(sig.subarray(32));
			if (s > N / 2n) sig.set(bigIntToBytes(N - s, 32), 32);
			return sig;
		},
	};
}

// --- HTTP message signature --------------------------------------------

export const SPACE_CREDENTIAL_SCHEME = "Atproto-Space-Credential";
const SIGNATURE_LABEL = "atproto-space-credential";
const SIGNATURE_PARAMS = `("authorization" "atproto-space-audience");tag="atproto-space-credential"`;

/**
 * The headers that present a space credential: the `Authorization` scheme,
 * the audience DID (the service being called — the repo DID at a repo
 * host, the authority DID at the space host) and an RFC 9421 signature by
 * the credential's key covering exactly those two fields.
 */
export async function spaceSigHeaders(
	key: Pick<CredentialKey, "sign">,
	opts: { authorization: string; audience: string },
): Promise<Record<string, string>> {
	const base = [
		`"authorization": ${opts.authorization.trim()}`,
		`"atproto-space-audience": ${opts.audience.trim()}`,
		`"@signature-params": ${SIGNATURE_PARAMS}`,
	].join("\n");
	const signature = await key.sign(utf8(base));
	return {
		authorization: opts.authorization,
		"atproto-space-audience": opts.audience,
		"signature-input": `${SIGNATURE_LABEL}=${SIGNATURE_PARAMS}`,
		// RFC 9651 byte sequences are padded base64.
		signature: `${SIGNATURE_LABEL}=:${toBase64(signature)}:`,
	};
}

// --- KEM / MAC request -------------------------------------------------

export const COMMIT_MAC_TYPE = "atproto-space-repo";
export const RECORD_MAC_TYPE = "atproto-space-record";
export type MacType = typeof COMMIT_MAC_TYPE | typeof RECORD_MAC_TYPE;
export const WANT_MAC_HEADER = "atproto-space-want-mac";
export const MAC_HEADER = "atproto-space-mac";

/** `type="…", ver=1, key_share="did:key:…"` — both MAC types are on v1. */
export const formatWantMacHeader = (type: MacType, keyShare: string): string =>
	`type="${type}", ver=1, key_share="${keyShare}"`;

const uint16be = (n: number) => new Uint8Array([n >>> 8, n & 0xff]);
const KEM_PREFIX = concatBytes([
	utf8("HPKE-v1"),
	utf8("KEM"),
	uint16be(0x0010),
]);

/**
 * Syncer side of the space KEM: ECDH between a fresh ephemeral P-256 key
 * and the author's `#atproto_kem` key, with the secret derived as in
 * DHKEM(P-256, HKDF-SHA256) (RFC 9180 §4.1). Use once per request.
 */
export async function encapsulate(
	authorKemDidKey: string,
): Promise<{ keyShare: string; sharedSecret: Uint8Array }> {
	const parsed = parseDidKey(authorKemDidKey);
	if (parsed.alg !== "ES256") throw new Error("KEM key must be P-256");
	const authorBytes = decompressP256(parsed.compressed);
	const authorKey = await crypto.subtle.importKey(
		"raw",
		authorBytes as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ephemeral = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const ephemeralBytes = new Uint8Array(
		await crypto.subtle.exportKey("raw", ephemeral.publicKey),
	);
	const dh = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: authorKey },
			ephemeral.privateKey,
			256,
		),
	);
	const ikm = concatBytes([KEM_PREFIX, utf8("eae_prk"), dh]);
	const info = concatBytes([
		uint16be(32),
		KEM_PREFIX,
		utf8("shared_secret"),
		ephemeralBytes,
		authorBytes,
	]);
	const hkdfKey = await crypto.subtle.importKey(
		"raw",
		ikm as BufferSource,
		"HKDF",
		false,
		["deriveBits"],
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: new Uint8Array(0),
				info: info as BufferSource,
			},
			hkdfKey,
			256,
		),
	);
	return { keyShare: formatDidKey("ES256", ephemeralBytes), sharedSecret };
}

/**
 * Pull the `mac` byte sequence out of an `Atproto-Space-Mac` header,
 * checking its type and version. Undefined when absent or malformed.
 */
export function parseMacHeader(
	value: string | null,
	type: MacType,
): Uint8Array | undefined {
	if (!value) return undefined;
	const fields = new Map<string, string>();
	for (const member of value.split(",")) {
		const eq = member.indexOf("=");
		if (eq < 0) continue;
		fields.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
	}
	if (fields.get("type") !== `"${type}"` || fields.get("ver") !== "1") {
		return undefined;
	}
	const mac = fields.get("mac");
	if (!mac || !mac.startsWith(":") || !mac.endsWith(":")) return undefined;
	try {
		return fromBase64(mac.slice(1, -1));
	} catch {
		return undefined;
	}
}
