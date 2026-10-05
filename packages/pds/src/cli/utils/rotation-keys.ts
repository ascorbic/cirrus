/**
 * PLC rotation key helpers: ordering, labelling, and recovery keys.
 *
 * Rotation keys are listed in priority order. A higher-priority key can
 * override an operation signed by a lower one for 72 hours, so keys the
 * user holds offline come before the PDS key.
 */
import {
	bytesToMultibase,
	multibaseToBytes,
	P256Keypair,
	Secp256k1Keypair,
	type Keypair,
} from "@atproto/crypto";
import type { PlcAuditLog } from "../../plc.js";

/** plc.directory accepts at most this many rotation keys */
export const MAX_ROTATION_KEYS = 5;

// Varint-encoded multicodec prefixes for private keys, as used by goat
const SECP256K1_PRIV_PREFIX = [0x81, 0x26];
const P256_PRIV_PREFIX = [0x86, 0x26];

export type RotationKeyOwner = "this-pds" | "source-pds" | "unknown";

export interface LabelledRotationKey {
	key: string;
	owner: RotationKeyOwner;
}

/**
 * Build the rotation key list: keys the user holds, in the order given,
 * followed by the PDS key.
 */
export function buildRotationKeys(opts: {
	userKeys: string[];
	pdsKey: string;
}): string[] {
	const keys = [
		...new Set([
			...opts.userKeys.filter((k) => k !== opts.pdsKey),
			opts.pdsKey,
		]),
	];
	const invalid = keys.find((k) => !k.startsWith("did:key:"));
	if (invalid) {
		throw new Error(`Not a did:key: ${invalid}`);
	}
	if (keys.length > MAX_ROTATION_KEYS) {
		throw new Error(
			`A DID can have at most ${MAX_ROTATION_KEYS} rotation keys (got ${keys.length})`,
		);
	}
	return keys;
}

/**
 * Tag each current rotation key with who holds it, where known.
 */
export function labelRotationKeys(
	current: string[],
	known: { pdsKey: string; sourcePdsKeys?: string[] },
): LabelledRotationKey[] {
	return current.map((key) => ({
		key,
		owner:
			key === known.pdsKey
				? "this-pds"
				: known.sourcePdsKeys?.includes(key)
					? "source-pds"
					: "unknown",
	}));
}

/**
 * Find the PDS a DID pointed at before the current one, from its PLC audit
 * log. Returns null if it has never pointed anywhere else.
 */
export function findPreviousPdsEndpoint(
	log: PlcAuditLog[],
	currentEndpoint: string,
): string | null {
	const current = currentEndpoint.replace(/\/$/, "");
	for (const entry of [...log].reverse()) {
		if (entry.nullified || entry.operation.type !== "plc_operation") continue;
		const endpoint = entry.operation.services.atproto_pds?.endpoint?.replace(
			/\/$/,
			"",
		);
		if (endpoint && endpoint !== current) {
			return endpoint;
		}
	}
	return null;
}

export interface RecoveryKey {
	/** Private key in multibase form, as used by goat's --plc-signing-key */
	privateKey: string;
	/** Public key as a did:key, for the rotationKeys list */
	did: string;
}

/**
 * Generate a secp256k1 recovery key.
 */
export async function generateRecoveryKey(): Promise<RecoveryKey> {
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const bytes = await keypair.export();
	return {
		privateKey: bytesToMultibase(
			new Uint8Array([...SECP256K1_PRIV_PREFIX, ...bytes]),
			"base58btc",
		),
		did: keypair.did(),
	};
}

/**
 * Parse a private rotation key pasted by the user: multibase (from goat or
 * generateRecoveryKey, secp256k1 or P-256), or a hex secp256k1 key like
 * the PDS signing key.
 */
export async function importRotationKey(input: string): Promise<Keypair> {
	const value = input.trim();
	if (/^[0-9a-f]{64}$/i.test(value)) {
		return Secp256k1Keypair.import(value.toLowerCase());
	}
	if (value.startsWith("z")) {
		let bytes: Uint8Array;
		try {
			bytes = multibaseToBytes(value);
		} catch {
			throw new Error("Not a valid multibase key");
		}
		const prefix = [bytes[0], bytes[1]];
		const key = bytes.slice(2);
		if (key.length === 32) {
			if (samePrefix(prefix, SECP256K1_PRIV_PREFIX)) {
				return Secp256k1Keypair.import(key);
			}
			if (samePrefix(prefix, P256_PRIV_PREFIX)) {
				return P256Keypair.import(key);
			}
		}
	}
	throw new Error(
		"Unrecognised key format. Expected a multibase private key (starting with z) or a 64-character hex key.",
	);
}

function samePrefix(a: Array<number | undefined>, b: number[]): boolean {
	return a[0] === b[0] && a[1] === b[1];
}
