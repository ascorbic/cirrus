/**
 * PLC directory operations shared by the PDS and the CLI.
 */
import type { Keypair } from "@atproto/crypto";
import { encode } from "@atcute/cbor";
import { base64url } from "jose";

export const PLC_DIRECTORY = "https://plc.directory";

export interface UnsignedPlcOperation {
	type: "plc_operation";
	prev: string | null;
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, { type: string; endpoint: string }>;
}

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
