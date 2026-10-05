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
import {
	CompositeHandleResolver,
	DohJsonHandleResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { isHandle } from "@atcute/lexicons/syntax";
import type { AccountDurableObject } from "../account-do";
import type { AuthedAppEnv, PDSEnv } from "../types";
import { requireIdentityControl, requireScope } from "../middleware/auth";
import {
	createMigrationToken,
	validateMigrationToken,
} from "../migration-token";
import {
	getLatestPlcOperation,
	PLC_DIRECTORY,
	signOperation,
	type PlcOperationChanges,
	type SignedPlcOperation,
	type UnsignedPlcOperation,
} from "../plc";

/**
 * TLDs that can never be used in a handle.
 * See https://atproto.com/specs/handle#additional-non-syntax-restrictions
 */
const DISALLOWED_TLDS = [
	".local",
	".arpa",
	".invalid",
	".localhost",
	".internal",
	".example",
	".alt",
	".onion",
];

/**
 * Wrapper that always uses globalThis.fetch so it can be mocked in tests.
 * @atcute resolvers capture the fetch reference at construction time.
 */
const stubbableFetch: typeof fetch = (input, init) =>
	globalThis.fetch(input, init);

// DNS first, then /.well-known/atproto-did, matching the reference PDS.
const handleResolver = new CompositeHandleResolver({
	strategy: "dns-first",
	methods: {
		dns: new DohJsonHandleResolver({
			dohUrl: "https://cloudflare-dns.com/dns-query",
			fetch: stubbableFetch,
		}),
		http: new WellKnownHandleResolver({ fetch: stubbableFetch }),
	},
});

/**
 * Get the account's current handle: the one set by updateHandle, or the
 * HANDLE var if it has not been changed.
 */
export function getHandle(
	env: PDSEnv,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<string> {
	return accountDO.account().getHandle(env.HANDLE);
}

/**
 * Build the DID document for the local account.
 *
 * Served by /.well-known/did.json.
 */
export function buildDidDocument(env: PDSEnv, handle: string) {
	return {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: env.DID,
		alsoKnownAs: [`at://${handle}`],
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
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const keypair = await Secp256k1Keypair.import(c.env.SIGNING_KEY);
	const signingKey = keypair.did();
	const handle = await getHandle(c.env, accountDO);

	return c.json({
		rotationKeys: [signingKey],
		alsoKnownAs: [`at://${handle}`],
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

	const body = await c.req.json<PlcOperationChanges & { token?: string }>();

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
 * Change the account's handle.
 *
 * The new handle must already resolve to this DID (via DNS TXT or
 * /.well-known/atproto-did). For did:plc accounts the handle is written to
 * alsoKnownAs in the PLC directory, which needs our signing key to be a
 * rotation key unless the directory already has it; for did:web accounts
 * the served DID document reads the stored handle. An identity event then
 * tells relays and AppViews to re-verify it.
 *
 * Endpoint: POST com.atproto.identity.updateHandle
 */
export async function updateHandle(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	// getServiceAuth mints these for any caller, so a self-addressed one would
	// skip the identity:handle check below. The reference PDS refuses them too.
	if (c.get("auth").method === "service") {
		return c.json(
			{
				error: "InsufficientScope",
				message: "Service auth tokens can't change the handle.",
			},
			403,
		);
	}

	const scopeError = requireScope(c, (perms) =>
		perms.assertIdentity({ attr: "handle" }),
	);
	if (scopeError) return scopeError;

	const body = await c.req
		.json<{ handle?: unknown }>()
		.catch(() => ({}) as { handle?: unknown });

	if (typeof body.handle !== "string") {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: handle",
			},
			400,
		);
	}

	const handle = body.handle.toLowerCase();
	if (!isHandle(handle)) {
		return c.json(
			{ error: "InvalidHandle", message: `Invalid handle: ${handle}` },
			400,
		);
	}
	if (DISALLOWED_TLDS.some((tld) => handle.endsWith(tld))) {
		return c.json(
			{
				error: "InvalidHandle",
				message: "Handle TLD is invalid or disallowed",
			},
			400,
		);
	}

	// /.well-known/atproto-did on our own hostname always serves our DID, so
	// there is nothing to look up for it.
	if (handle !== c.env.PDS_HOSTNAME) {
		const resolved = await handleResolver
			.resolve(handle, { signal: AbortSignal.timeout(10000) })
			.catch(() => null);
		if (resolved !== c.env.DID) {
			return c.json(
				{
					error: "InvalidRequest",
					message: `Handle ${handle} does not resolve to ${c.env.DID}. Add a DNS TXT record for _atproto.${handle} with the value "did=${c.env.DID}", or serve the DID at https://${handle}/.well-known/atproto-did.`,
				},
				400,
			);
		}
	}

	if (c.env.DID.startsWith("did:plc:")) {
		const error = await updatePlcHandle(c, handle);
		if (error) return error;
	}

	await accountDO.account().setHandle(handle, c.env.HANDLE);
	await accountDO.repo().emitIdentityEvent(handle);

	return new Response(null, { status: 200 });
}

/**
 * Write the handle to alsoKnownAs in the PLC directory, replacing the
 * existing at:// entry. Does nothing if the directory already has it.
 * Returns an error response on failure, or null on success.
 */
async function updatePlcHandle(
	c: Context<AuthedAppEnv>,
	handle: string,
): Promise<Response | null> {
	const current = await getLatestPlcOperation(c.env.DID);
	if (!current || current.operation.type !== "plc_operation") {
		return c.json(
			{
				error: "InternalServerError",
				message: "Could not fetch current PLC state",
			},
			500,
		);
	}

	const { operation } = current;
	const aka = `at://${handle}`;
	const akaIndex = operation.alsoKnownAs.findIndex((uri) =>
		uri.startsWith("at://"),
	);
	if (operation.alsoKnownAs[akaIndex] === aka) return null;

	const keypair = await Secp256k1Keypair.import(c.env.SIGNING_KEY);
	if (!operation.rotationKeys.includes(keypair.did())) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `This PDS's signing key is not a rotation key for ${c.env.DID}, so it cannot update the handle in the PLC directory. Run "pds rotation-keys" to give it control, or set alsoKnownAs to ${aka} with a rotation key you hold, then try again.`,
			},
			400,
		);
	}

	// Replace the first at:// entry, which is the one handles are verified
	// against, and drop any other copy of the new handle.
	const alsoKnownAs =
		akaIndex < 0
			? [aka, ...operation.alsoKnownAs]
			: operation.alsoKnownAs
					.map((uri, i) => (i === akaIndex ? aka : uri))
					.filter((uri, i) => uri !== aka || i === akaIndex);

	const signedOp = await signOperation(
		{
			type: "plc_operation",
			prev: current.cid,
			rotationKeys: operation.rotationKeys,
			verificationMethods: operation.verificationMethods,
			alsoKnownAs,
			services: operation.services,
		},
		keypair,
	);

	const res = await fetch(`${PLC_DIRECTORY}/${c.env.DID}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(signedOp),
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

	return null;
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
