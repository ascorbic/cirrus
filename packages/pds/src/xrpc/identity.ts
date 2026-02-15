/**
 * Identity XRPC endpoints for outbound migration
 *
 * These endpoints allow migrating FROM Cirrus to another PDS.
 *
 * Flow:
 * 1. New PDS calls requestPlcOperationSignature (after user authenticates)
 * 2. We generate a migration token (stateless HMAC)
 * 3. User runs `pds migrate-token` CLI to get the token
 * 4. User enters token into new PDS
 * 5. New PDS calls signPlcOperation with token + new endpoint/key
 * 6. We validate token and return signed PLC operation
 * 7. New PDS submits operation to PLC directory
 */
import type { Context } from "hono";
import { Secp256k1Keypair } from "@atproto/crypto";
import { encode } from "@atcute/cbor";
import { base64url } from "jose";
import type { AuthedAppEnv } from "../types";
import {
	createMigrationToken,
	validateMigrationToken,
} from "../migration-token";

const PLC_DIRECTORY = "https://plc.directory";

/**
 * PLC operation structure
 */
interface UnsignedPlcOperation {
	type: "plc_operation";
	prev: string | null;
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, { type: string; endpoint: string }>;
}

interface SignedPlcOperation extends UnsignedPlcOperation {
	sig: string;
}

/**
 * Audit log entry from plc.directory
 */
interface PlcAuditLog {
	did: string;
	operation: SignedPlcOperation;
	cid: string;
	nullified: boolean;
	createdAt: string;
}

/**
 * Request a PLC operation signature for outbound migration.
 *
 * In Bluesky's implementation, this sends an email with a token.
 * In Cirrus, we're single-user with no email, so we just return success.
 * The user gets the token via `pds migrate-token` CLI.
 *
 * Endpoint: POST com.atproto.identity.requestPlcOperationSignature
 */
export async function requestPlcOperationSignature(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	// For Cirrus, we don't send emails - the user gets the token via CLI.
	// Just return success to indicate the request was accepted.
	// The token is generated on-demand when the user runs `pds migrate-token`.
	return new Response(null, { status: 200 });
}

/**
 * Sign a PLC operation for migrating to a new PDS.
 *
 * Validates the migration token and returns a signed PLC operation
 * that updates the DID document to point to the new PDS.
 *
 * Endpoint: POST com.atproto.identity.signPlcOperation
 */
export async function signPlcOperation(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	const body = await c.req.json<{
		token?: string;
		rotationKeys?: string[];
		alsoKnownAs?: string[];
		verificationMethods?: Record<string, string>;
		services?: Record<string, { type: string; endpoint: string }>;
	}>();

	const { token } = body;

	if (!token) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: token",
			},
			400,
		);
	}

	// Validate the migration token
	const payload = await validateMigrationToken(
		token,
		c.env.DID,
		c.env.JWT_SECRET,
	);

	if (!payload) {
		return c.json(
			{
				error: "InvalidToken",
				message: "Invalid or expired migration token",
			},
			400,
		);
	}

	// Get current PLC state to build the update
	const currentOp = await getLatestPlcOperation(c.env.DID);
	if (!currentOp) {
		return c.json(
			{
				error: "InternalServerError",
				message: "Could not fetch current PLC state",
			},
			500,
		);
	}

	// Build the new operation, merging current state with requested changes
	const newOp: UnsignedPlcOperation = {
		type: "plc_operation",
		prev: currentOp.cid,
		rotationKeys: body.rotationKeys ?? currentOp.operation.rotationKeys,
		alsoKnownAs: body.alsoKnownAs ?? currentOp.operation.alsoKnownAs,
		verificationMethods:
			body.verificationMethods ?? currentOp.operation.verificationMethods,
		services: body.services ?? currentOp.operation.services,
	};

	// Sign the operation with our signing key
	const keypair = await Secp256k1Keypair.import(c.env.SIGNING_KEY);
	const signedOp = await signOperation(newOp, keypair);

	return c.json({ operation: signedOp });
}

/**
 * Get the latest PLC operation for a DID
 */
async function getLatestPlcOperation(did: string): Promise<PlcAuditLog | null> {
	try {
		const res = await fetch(`${PLC_DIRECTORY}/${did}/log/audit`);
		if (!res.ok) {
			return null;
		}
		const log = (await res.json()) as PlcAuditLog[];
		// Return the most recent non-nullified operation
		return log.filter((op) => !op.nullified).pop() ?? null;
	} catch {
		return null;
	}
}

/**
 * Sign a PLC operation with the given keypair
 *
 * PLC operations are signed by:
 * 1. CBOR-encoding the unsigned operation
 * 2. Signing the bytes with secp256k1
 * 3. Adding the signature as base64url
 */
async function signOperation(
	op: UnsignedPlcOperation,
	keypair: Secp256k1Keypair,
): Promise<SignedPlcOperation> {
	// CBOR-encode the operation (without sig field)
	const bytes = encode(op);

	// Sign the bytes
	const sig = await keypair.sign(bytes);

	// Convert signature to base64url
	return {
		...op,
		sig: base64url.encode(sig),
	};
}

/**
 * Generate a migration token for the CLI.
 *
 * This endpoint allows the CLI to generate a token that can be used
 * to complete an outbound migration without requiring the secret
 * to be available client-side.
 *
 * Endpoint: GET gg.mk.experimental.getMigrationToken
 */
export async function getMigrationToken(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	const token = await createMigrationToken(c.env.DID, c.env.JWT_SECRET);
	return c.json({ token });
}
