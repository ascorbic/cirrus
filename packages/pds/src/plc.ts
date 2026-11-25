/**
 * PLC directory operations shared by the PDS and the CLI.
 */
import type { Keypair } from "@atproto/crypto";
import { encode } from "@atcute/cbor";
import { base64url } from "jose";

export const PLC_DIRECTORY = "https://plc.directory";

/**
 * Headers for submitting a PLC operation (POST /{did}). An update (any
 * operation with a `prev`) carries `If-Match: *`, which tells the directory
 * the DID already exists, so it is rate-limited per identifier rather than
 * per IP. That matters on Workers, whose egress IPs are shared. A genesis
 * operation (`prev: null`) must not carry it. Directories that predate the
 * header ignore it.
 * https://discourse.atmosphere.community/t/plc-directory-and-rate-limits/1506
 */
export function plcSubmitHeaders(operation: {
	prev?: string | null;
}): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...(typeof operation.prev === "string" ? { "If-Match": "*" } : {}),
	};
}

export interface UnsignedPlcOperation {
	type: "plc_operation";
	prev: string | null;
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, { type: string; endpoint: string }>;
}

/**
 * Fields a caller can change when asking a PDS to sign an operation.
 * Omitted fields keep their current values.
 */
export type PlcOperationChanges = Partial<
	Pick<
		UnsignedPlcOperation,
		"rotationKeys" | "verificationMethods" | "alsoKnownAs" | "services"
	>
>;

export interface SignedPlcOperation extends UnsignedPlcOperation {
	sig: string;
}

/**
 * Operation types other than plc_operation that can appear in a DID's log:
 * tombstones, and the legacy "create" genesis format.
 */
export interface OtherPlcOperation {
	type: "plc_tombstone" | "create";
	prev: string | null;
	sig: string;
}

export interface PlcAuditLog {
	did: string;
	operation: SignedPlcOperation | OtherPlcOperation;
	cid: string;
	nullified: boolean;
	createdAt: string;
}

/**
 * Set the account's handle in an alsoKnownAs list. Handles are verified
 * against the first at:// entry, so the handle replaces it, or is added
 * first if there is none. Any later copy of the handle is dropped, and
 * other entries are kept.
 */
export function withHandle(alsoKnownAs: string[], handle: string): string[] {
	const aka = `at://${handle}`;
	const first = alsoKnownAs.findIndex((uri) => uri.startsWith("at://"));
	if (first < 0) {
		return [aka, ...alsoKnownAs];
	}
	return alsoKnownAs
		.map((uri, i) => (i === first ? aka : uri))
		.filter((uri, i) => uri !== aka || i === first);
}

/**
 * Get the most recent non-nullified operation for a DID, or null if the
 * log cannot be fetched.
 */
export async function getLatestPlcOperation(
	did: string,
	plcUrl = PLC_DIRECTORY,
): Promise<PlcAuditLog | null> {
	try {
		const res = await fetch(`${plcUrl}/${did}/log/audit`);
		if (!res.ok) {
			return null;
		}
		const log = (await res.json()) as PlcAuditLog[];
		return log.filter((op) => !op.nullified).pop() ?? null;
	} catch {
		return null;
	}
}

/**
 * Sign a PLC operation: DAG-CBOR encode the unsigned operation, sign the
 * bytes, and attach the signature as base64url.
 */
export async function signOperation(
	op: UnsignedPlcOperation,
	keypair: Keypair,
): Promise<SignedPlcOperation> {
	const sig = await keypair.sign(encode(op));
	return { ...op, sig: base64url.encode(sig) };
}
