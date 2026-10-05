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
import type { AuthedAppEnv, PDSEnv } from "../types";
import { requireIdentityControl } from "../middleware/auth";
import {
	createMigrationToken,
	validateMigrationToken,
} from "../migration-token";
import {
	getLatestPlcOperation,
	PLC_DIRECTORY,
	signOperation,
	type SignedPlcOperation,
	type UnsignedPlcOperation,
} from "../plc";

/**
 * Build the DID document for the local account.
 *
 * Served by /.well-known/did.json.
 */
export function buildDidDocument(env: PDSEnv) {
	return {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: env.DID,
		alsoKnownAs: [`at://${env.HANDLE}`],
		verificationMethod: [
			{
				id: `${env.DID}#atproto`,
				type: "Multikey",
				controller: env.DID,
				publicKeyMultibase: env.SIGNING_KEY_PUBLIC,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: `https://${env.PDS_HOSTNAME}`,
			},
			// Spaces alpha: advertise the space host endpoint. No dedicated
			// #atproto_space verification key is added — the proposal falls
			// back to #atproto, and a second key would create a rotation and
			// backup story for no benefit on a single-user PDS.
			...(env.SPACES_ENABLED === "true"
				? [
						{
							id: "#atproto_space_host",
							type: "AtprotoSpaceHost",
							serviceEndpoint: `https://${env.PDS_HOSTNAME}`,
						},
					]
				: []),
		],
	};
}

/**
 * Return recommended PLC credentials for the current account.
 *
 * Used by other PDSes during an inbound migration to discover the
 * keys / services they should attach to a new PLC operation.
 *
 * Endpoint: GET com.atproto.identity.getRecommendedDidCredentials
 */
export async function getRecommendedDidCredentials(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	const keypair = await Secp256k1Keypair.import(c.env.SIGNING_KEY);
	const signingKey = keypair.did();

	return c.json({
		rotationKeys: [signingKey],
		alsoKnownAs: [`at://${c.env.HANDLE}`],
		verificationMethods: { atproto: signingKey },
		services: {
			atproto_pds: {
				type: "AtprotoPersonalDataServer",
				endpoint: `https://${c.env.PDS_HOSTNAME}`,
			},
		},
	});
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
 * Sign a PLC operation with this PDS's signing key.
 *
 * Validates the migration token and returns a signed PLC operation that
 * applies the requested changes to the current PLC state. Used by a new PDS
 * during outbound migration, and by `pds rotation-keys`. The signing key
 * must be one of the DID's rotation keys, or plc.directory would reject
 * the operation.
 *
 * Endpoint: POST com.atproto.identity.signPlcOperation
 */
export async function signPlcOperation(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	const forbidden = requireIdentityControl(c);
	if (forbidden) return forbidden;

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
	if (!currentOp || currentOp.operation.type !== "plc_operation") {
		return c.json(
			{
				error: "InternalServerError",
				message: "Could not fetch current PLC state",
			},
			500,
		);
	}

	const keypair = await Secp256k1Keypair.import(c.env.SIGNING_KEY);
	if (!currentOp.operation.rotationKeys.includes(keypair.did())) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `This PDS's signing key is not a rotation key for ${c.env.DID}, so it cannot sign identity changes. Run "pds rotation-keys" to give it control, or sign the operation with a rotation key you hold.`,
			},
			400,
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

	const signedOp = await signOperation(newOp, keypair);

	return c.json({ operation: signedOp });
}

/**
 * Submit a signed PLC operation to the PLC directory.
 *
 * Forwards an already-signed operation (e.g. one produced by
 * signPlcOperation) to plc.directory on the user's behalf, so
 * migration clients don't have to talk to the directory themselves.
 *
 * Endpoint: POST com.atproto.identity.submitPlcOperation
 */
export async function submitPlcOperation(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	const body = await c.req.json<{ operation?: SignedPlcOperation }>();

	const { operation } = body;

	if (!operation) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: operation",
			},
			400,
		);
	}

	const res = await fetch(`${PLC_DIRECTORY}/${c.env.DID}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(operation),
	});

	if (!res.ok) {
		const message = await res.text();
		return new Response(
			JSON.stringify({
				error: "PlcDirectoryError",
				message: message || `PLC directory responded with ${res.status}`,
			}),
			{
				status: res.status,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	return new Response(null, { status: 200 });
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
	const forbidden = requireIdentityControl(c);
	if (forbidden) return forbidden;

	const token = await createMigrationToken(c.env.DID, c.env.JWT_SECRET);
	return c.json({ token });
}
