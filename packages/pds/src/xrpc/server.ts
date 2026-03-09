import type { Context } from "hono";
import {
	createAccessToken,
	createRefreshToken,
	verifyAccessToken,
	verifyRefreshToken,
	TokenExpiredError,
} from "../session";
import { createServiceJwt } from "../service-auth";
import { Secp256k1Keypair } from "@atproto/crypto";
import { hostnameToFid, fidToDid } from "../farcaster-auth";
import type { PDSEnv, AppEnv, AuthedAppEnv } from "../types";
import type { AccountDurableObject } from "../account-do";

/** Function type for getting Account DO by DID */
type GetAccountDO = (
	env: PDSEnv,
	did: string,
) => DurableObjectStub<AccountDurableObject>;

/**
 * Create a new session.
 *
 * Password-based login is not supported. Use Farcaster Quick Auth instead.
 */
export async function createSession(c: Context<AppEnv>): Promise<Response> {
	return c.json(
		{
			error: "InvalidRequest",
			message:
				"Password-based login is not supported. Use POST /xrpc/is.fid.auth.login*",
		},
		400,
	);
}

/**
 * Refresh a session.
 */
export async function refreshSession(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const authHeader = c.req.header("Authorization");

	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Refresh token required",
			},
			401,
		);
	}

	const token = authHeader.slice(7);

	// Derive service DID from request hostname (per-user subdomain mode)
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const hostFid = hostnameToFid(hostname, domain);
	if (!hostFid) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Invalid hostname - must use WebFID subdomain",
			},
			400,
		);
	}
	const serviceDid = fidToDid(hostFid, domain);

	try {
		const payload = await verifyRefreshToken(
			token,
			c.env.JWT_SECRET,
			serviceDid,
		);

		const sub = payload.sub;
		if (!sub) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid refresh token - missing subject",
				},
				401,
			);
		}

		const did = sub;
		const accountDO = getAccountDO(c.env, did);
		const identity = await accountDO.rpcGetAtprotoIdentity();
		if (!identity) {
			return c.json(
				{
					error: "AccountNotFound",
					message: "Account no longer exists",
				},
				401,
			);
		}

		const handle = identity.handle;

		const accessJwt = await createAccessToken(
			c.env.JWT_SECRET,
			did,
			serviceDid,
		);
		const refreshJwt = await createRefreshToken(
			c.env.JWT_SECRET,
			did,
			serviceDid,
		);

		const { email } = await accountDO.rpcGetEmail();

		return c.json({
			accessJwt,
			refreshJwt,
			handle,
			did,
			...(email ? { email } : {}),
			active: true,
		});
	} catch (err) {
		if (err instanceof TokenExpiredError) {
			return c.json(
				{
					error: "ExpiredToken",
					message: err.message,
				},
				400,
			);
		}
		return c.json(
			{
				error: "InvalidToken",
				message: err instanceof Error ? err.message : "Invalid refresh token",
			},
			400,
		);
	}
}

/**
 * Get current session info.
 */
export async function getSession(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const domain = c.env.WEBFID_DOMAIN;

	// Check if DPoP middleware already verified the token
	const dpopDid = c.get("did" as never) as string | undefined;

	let did: string;

	if (dpopDid) {
		// OAuth DPoP token — already verified by middleware
		did = dpopDid;
	} else {
		// Fall back to Bearer JWT verification
		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Access token required",
				},
				401,
			);
		}

		const token = authHeader.slice(7);

		// Derive service DID from request hostname (per-user subdomain mode)
		const hostname = new URL(c.req.url).hostname;
		const hostFid = hostnameToFid(hostname, domain);
		if (!hostFid) {
			return c.json(
				{
					error: "InvalidRequest",
					message: "Invalid hostname - must use WebFID subdomain",
				},
				400,
			);
		}
		const serviceDid = fidToDid(hostFid, domain);

		try {
			const payload = await verifyAccessToken(
				token,
				c.env.JWT_SECRET,
				serviceDid,
			);

			const sub = payload.sub;
			if (!sub) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Invalid access token",
					},
					401,
				);
			}
			did = sub;
		} catch (err) {
			if (err instanceof TokenExpiredError) {
				return c.json(
					{
						error: "ExpiredToken",
						message: err.message,
					},
					400,
				);
			}
			return c.json(
				{
					error: "InvalidToken",
					message: err instanceof Error ? err.message : "Invalid access token",
				},
				401,
			);
		}
	}

	const accountDO = getAccountDO(c.env, did);
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{
				error: "AccountNotFound",
				message: "Account not found",
			},
			401,
		);
	}

	const handle = identity.handle;

	const { email } = await accountDO.rpcGetEmail();

	return c.json({
		handle,
		did,
		...(email ? { email } : {}),
		active: true,
	});
}

/**
 * Delete current session (logout).
 */
export async function deleteSession(c: Context<AppEnv>): Promise<Response> {
	// Stateless JWTs - nothing to delete on server side
	return c.json({});
}

/**
 * Get account status.
 */
export async function checkAccountStatus(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	try {
		const repoStatus = await accountDO.rpcGetRepoStatus();

		const [repoBlocks, indexedRecords, expectedBlobs, importedBlobs] =
			await Promise.all([
				accountDO.rpcCountBlocks(),
				accountDO.rpcCountRecords(),
				accountDO.rpcCountExpectedBlobs(),
				accountDO.rpcCountImportedBlobs(),
			]);

		const activated = repoStatus.active || indexedRecords > 0;

		return c.json({
			activated,
			active: repoStatus.active,
			validDid: true,
			repoCommit: repoStatus.head,
			repoRev: repoStatus.rev,
			repoBlocks,
			indexedRecords,
			privateStateValues: null,
			expectedBlobs,
			importedBlobs,
		});
	} catch {
		return c.json({
			activated: false,
			active: false,
			validDid: true,
			repoCommit: null,
			repoRev: null,
			repoBlocks: 0,
			indexedRecords: 0,
			privateStateValues: null,
			expectedBlobs: 0,
			importedBlobs: 0,
		});
	}
}

/**
 * Get a service auth token for external services.
 */
export async function getServiceAuth(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const aud = c.req.query("aud");
	const lxm = c.req.query("lxm") || null;

	if (!aud) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: aud",
			},
			400,
		);
	}

	// Get identity from DO to get the signing key
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{
				error: "AccountNotFound",
				message: "Account identity not found",
			},
			404,
		);
	}

	// Create service JWT
	const keypair = await Secp256k1Keypair.import(identity.signingKey);
	const token = await createServiceJwt({
		iss: identity.did,
		aud,
		lxm,
		keypair,
	});

	return c.json({ token });
}

/**
 * Activate account.
 */
export async function activateAccount(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	try {
		await accountDO.rpcActivateAccount();
		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{
				error: "InternalServerError",
				message: err instanceof Error ? err.message : "Unknown error",
			},
			500,
		);
	}
}

/**
 * Deactivate account.
 */
export async function deactivateAccount(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	try {
		await accountDO.rpcDeactivateAccount();
		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{
				error: "InternalServerError",
				message: err instanceof Error ? err.message : "Unknown error",
			},
			500,
		);
	}
}

/**
 * Request a token to update the account email.
 * No token needed, always returns tokenRequired: false.
 */
export async function requestEmailUpdate(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	return c.json({ tokenRequired: false });
}

/**
 * Request email confirmation.
 * Email is always confirmed, nothing to do.
 */
export async function requestEmailConfirmation(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	return c.json({});
}

/**
 * Update the account email address
 */
export async function updateEmail(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json<{ email: string }>();

	if (!body.email) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required field: email",
			},
			400,
		);
	}

	await accountDO.rpcUpdateEmail(body.email);
	return c.json({});
}

/**
 * Reset migration state - clears imported repo and blob tracking.
 * Only works on deactivated accounts.
 */
export async function resetMigration(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	try {
		const result = await accountDO.rpcResetMigration();
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";

		// Check for specific error types
		if (message.includes("AccountActive")) {
			return c.json(
				{
					error: "AccountActive",
					message:
						"Cannot reset migration on an active account. Deactivate first.",
				},
				400,
			);
		}

		return c.json(
			{
				error: "InternalServerError",
				message,
			},
			500,
		);
	}
}
