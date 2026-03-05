/**
 * FID Account Management Endpoints
 *
 * Custom XRPC endpoints for Farcaster-based account creation and login.
 */

import type { Context } from "hono";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createAppClient, viemConnector } from "@farcaster/auth-client";
import {
	verifyQuickAuthToken,
	fidToDid,
	fidToHandle,
} from "../farcaster-auth";
import { createAccessToken, createRefreshToken } from "../session";
import type { PDSEnv, AppEnv } from "../types";
import type { AccountDurableObject } from "../account-do";
import { registerUser, deleteUser, isAllowed, isWaitlisted, joinWaitlist as joinWaitlistDb } from "../user-registry";
import { didToFid } from "../farcaster-auth";
import type { AuthedAppEnv } from "../types";

/** Function type for getting Account DO by DID */
type GetAccountDO = (
	env: PDSEnv,
	did: string,
) => DurableObjectStub<AccountDurableObject>;

/**
 * Create a new account using Farcaster Quick Auth.
 *
 * POST /xrpc/is.fid.account.create
 * Input: { farcasterToken: string }
 * Auth: Farcaster Quick Auth JWT in request body
 *
 * This endpoint:
 * 1. Verifies the Farcaster Quick Auth token
 * 2. Derives DID and handle from the FID
 * 3. Generates a new signing keypair
 * 4. Stores credentials in the account's Durable Object
 * 5. Returns session tokens
 */
export async function createAccount(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const body = await c.req.json<{ farcasterToken: string; handle?: string }>().catch(() => null);

	if (!body?.farcasterToken) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing farcasterToken in request body",
			},
			400,
		);
	}

	// QUICKAUTH_DOMAIN is the miniapp domain — the audience of the Quick Auth JWT
	// issued by auth.farcaster.xyz. Required so we verify the token was intended
	// for our miniapp, not some other Farcaster app.
	if (!c.env.QUICKAUTH_DOMAIN) {
		return c.json(
			{
				error: "ServerError",
				message: "QUICKAUTH_DOMAIN not configured",
			},
			500,
		);
	}

	let fid: string;
	try {
		fid = await verifyQuickAuthToken(
			body.farcasterToken,
			c.env.QUICKAUTH_DOMAIN,
		);
	} catch (err) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message:
					err instanceof Error
						? err.message
						: "Invalid Farcaster authentication",
			},
			401,
		);
	}

	// Derive DID from FID; use provided handle or default to NNN.fid.is
	const did = fidToDid(fid, c.env.WEBFID_DOMAIN);
	const handle = body.handle || fidToHandle(fid, c.env.WEBFID_DOMAIN);

	// Get the account's Durable Object (route by DID)
	const accountDO = getAccountDO(c.env, did);

	// Check if account already exists — handle idempotent creation
	const exists = await accountDO.rpcAccountExists();

	// Allowlist gate: block new account creation if FID is not on the allowlist
	if (
		!exists &&
		c.env.ALLOWLIST_ENABLED === "true" &&
		c.env.USER_REGISTRY &&
		!(await isAllowed(c.env.USER_REGISTRY, fid))
	) {
		return c.json(
			{ error: "NotAllowed", message: "This FID is not on the allowlist" },
			403,
		);
	}

	if (exists) {
		// Account exists — return tokens (activate only if deactivated, not deleted)
		const repoStatus = await accountDO.rpcGetRepoStatus();
		if (repoStatus.status === "deactivated") {
			await accountDO.rpcActivateAccount();
		}
		const identity = await accountDO.rpcGetAtprotoIdentity();
		const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
		const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);
		return c.json({
			accessJwt,
			refreshJwt,
			handle: identity?.handle ?? "",
			did,
			active: repoStatus.status !== "deleted",
		});
	}

	// Generate new signing keypair
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const signingKeyBytes = await keypair.export();
	// Convert to hex string (Cloudflare Workers compatible)
	const signingKey = Array.from(signingKeyBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const signingKeyPublic = keypair.did().replace("did:key:", "");

	try {
		await accountDO.rpcSetAtprotoIdentity({
			did,
			handle,
			signingKey,
			signingKeyPublic,
		});
	} catch (err) {
		// Race condition: identity was created between our check and set
		if (err instanceof Error && err.message.includes("already exists")) {
			await accountDO.rpcActivateAccount();
			const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
			const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);
			return c.json({
				accessJwt,
				refreshJwt,
				handle,
				did,
				active: true,
			});
		}
		throw err;
	}

	// Explicitly activate the account (ensures status is correct after deleteAll/recreation)
	await accountDO.rpcActivateAccount();

	// Emit identity event so relays and AppView refresh their DID document cache.
	// Critical after re-creation: the signing key changed, so downstream services
	// need to fetch the new DID document to verify service JWTs.
	try {
		await accountDO.rpcEmitIdentityEvent(handle);
	} catch {
		// Best-effort — don't fail account creation
	}

	// Register user in global registry (if D1 database is configured)
	if (c.env.USER_REGISTRY) {
		await registerUser(c.env.USER_REGISTRY, fid, signingKeyPublic);
	}

	// Create session tokens with aud = user's PDS DID (did:web:NNN.fid.is)
	const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
	const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);

	return c.json({
		accessJwt,
		refreshJwt,
		handle,
		did,
		active: true,
	});
}

/**
 * Login with Farcaster Quick Auth.
 *
 * POST /xrpc/is.fid.auth.login
 * Input: { farcasterToken: string }
 * Auth: Farcaster Quick Auth JWT in request body
 *
 * This endpoint:
 * 1. Verifies the Farcaster Quick Auth token
 * 2. Checks that the account exists
 * 3. Returns session tokens
 */
export async function loginWithFarcaster(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const body = await c.req.json<{ farcasterToken: string }>().catch(() => null);

	if (!body?.farcasterToken) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing farcasterToken in request body",
			},
			400,
		);
	}

	// QUICKAUTH_DOMAIN is the miniapp domain — the audience of the Quick Auth JWT
	if (!c.env.QUICKAUTH_DOMAIN) {
		return c.json(
			{
				error: "ServerError",
				message: "QUICKAUTH_DOMAIN not configured",
			},
			500,
		);
	}

	let fid: string;
	try {
		fid = await verifyQuickAuthToken(
			body.farcasterToken,
			c.env.QUICKAUTH_DOMAIN,
		);
	} catch (err) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message:
					err instanceof Error
						? err.message
						: "Invalid Farcaster authentication",
			},
			401,
		);
	}

	const did = fidToDid(fid, c.env.WEBFID_DOMAIN);

	// Get the account's Durable Object (route by DID)
	const accountDO = getAccountDO(c.env, did);

	// Check account exists
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{
				error: "AccountNotFound",
				message: `No account found for FID ${fid}. Use is.fid.account.create first.`,
			},
			404,
		);
	}

	const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
	const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);

	return c.json({
		accessJwt,
		refreshJwt,
		handle: identity.handle,
		did,
		active: true,
	});
}

/**
 * Verify SIWF credentials and return the FID.
 * Shared by loginWithSiwf and createAccountSiwf.
 */
async function verifySiwfCredentials(
	body: { message: string; signature: `0x${string}`; fid: string; nonce: string },
	domain: string,
	alchemyApiKey?: string,
): Promise<{ fid: string; farcasterAddress?: string }> {
	const rpcUrl = alchemyApiKey
		? `https://opt-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
		: undefined;
	const appClient = createAppClient({
		ethereum: viemConnector({ rpcUrl }),
	});

	const verifyResult = await appClient.verifySignInMessage({
		message: body.message,
		signature: body.signature,
		domain,
		nonce: body.nonce,
	});

	if (!verifyResult.success) {
		throw new SiwfError("AuthenticationRequired", "Invalid SIWF signature", 401);
	}

	const fid = String(verifyResult.fid);
	if (!/^[1-9]\d*$/.test(fid)) {
		throw new SiwfError("InvalidRequest", "Invalid FID from SIWF verification", 400);
	}
	if (fid !== body.fid) {
		throw new SiwfError("AuthenticationRequired", "FID mismatch", 401);
	}

	const farcasterAddress =
		"address" in verifyResult ? (verifyResult.address as string) : undefined;

	return { fid, farcasterAddress };
}

class SiwfError extends Error {
	constructor(
		public code: string,
		message: string,
		public status: number,
	) {
		super(message);
	}
}

function parseSiwfBody(c: Context<AppEnv>) {
	return c.req
		.json<{
			message: string;
			signature: `0x${string}`;
			fid: string;
			nonce: string;
			handle?: string;
		}>()
		.catch(() => null);
}

function validateSiwfBody(
	c: Context<AppEnv>,
	body: { message?: string; signature?: string; fid?: string; nonce?: string } | null,
): Response | null {
	if (!body?.message || !body?.signature || !body?.fid || !body?.nonce) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required fields: message, signature, fid, nonce",
			},
			400,
		);
	}
	return null;
}

/**
 * Check account existence by FID. Always returns 200.
 *
 * GET /xrpc/is.fid.account.status?fid=12345
 * Response: { fid, exists: boolean }
 */
export async function getAccountStatus(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const fid = c.req.query("fid");
	if (!fid || !/^[1-9]\d*$/.test(fid)) {
		return c.json({ error: "InvalidRequest", message: "Missing or invalid fid parameter" }, 400);
	}

	const domain = c.env.WEBFID_DOMAIN;
	const did = fidToDid(fid, domain);
	const accountDO = getAccountDO(c.env, did);

	const exists = await accountDO.rpcAccountExists();

	// Allowlist gate: if enabled, check whether this FID is allowed/waitlisted
	let allowed = true;
	let waitlisted = false;
	if (
		c.env.ALLOWLIST_ENABLED === "true" &&
		c.env.USER_REGISTRY &&
		!exists
	) {
		[allowed, waitlisted] = await Promise.all([
			isAllowed(c.env.USER_REGISTRY, fid),
			isWaitlisted(c.env.USER_REGISTRY, fid),
		]);
	}

	return c.json({ fid, exists, allowed, waitlisted });
}

/**
 * Login with Sign In With Farcaster (SIWF) — login only.
 *
 * POST /xrpc/is.fid.auth.siwf
 * Input: { message: string, signature: string, fid: string, nonce: string }
 *
 * This endpoint verifies a SIWF signature and logs in an existing account.
 * Returns 404 if the account doesn't exist.
 */
export async function loginWithSiwf(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const body = await parseSiwfBody(c);
	const validationError = validateSiwfBody(c, body);
	if (validationError) return validationError;

	const domain = c.env.WEBFID_DOMAIN;

	let fid: string;
	try {
		({ fid } = await verifySiwfCredentials(body!, domain, c.env.ALCHEMY_API_KEY));
	} catch (err) {
		if (err instanceof SiwfError) {
			return c.json({ error: err.code, message: err.message }, err.status as any);
		}
		throw err;
	}

	const did = fidToDid(fid, domain);
	const accountDO = getAccountDO(c.env, did);

	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{
				error: "AccountNotFound",
				message: `No account found for FID ${fid}. Use is.fid.account.createSiwf first.`,
			},
			404,
		);
	}

	const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
	const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);

	return c.json({
		accessJwt,
		refreshJwt,
		handle: identity.handle,
		did,
		active: true,
	});
}

/**
 * Create a new account using Sign In With Farcaster (SIWF).
 *
 * POST /xrpc/is.fid.account.createSiwf
 * Input: { message: string, signature: string, fid: string, nonce: string }
 *
 * This endpoint verifies a SIWF signature and creates a new account.
 * If the account already exists, returns session tokens (idempotent).
 */
export async function createAccountSiwf(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const body = await parseSiwfBody(c);
	const validationError = validateSiwfBody(c, body);
	if (validationError) return validationError;

	const domain = c.env.WEBFID_DOMAIN;

	let fid: string;
	let farcasterAddress: string | undefined;
	try {
		({ fid, farcasterAddress } = await verifySiwfCredentials(body!, domain, c.env.ALCHEMY_API_KEY));
	} catch (err) {
		if (err instanceof SiwfError) {
			return c.json({ error: err.code, message: err.message }, err.status as any);
		}
		throw err;
	}

	const did = fidToDid(fid, domain);
	const handle = body!.handle || fidToHandle(fid, domain);
	const accountDO = getAccountDO(c.env, did);

	// Check if account already exists — handle idempotent creation
	const exists = await accountDO.rpcAccountExists();

	// Allowlist gate: block new account creation if FID is not on the allowlist
	if (
		!exists &&
		c.env.ALLOWLIST_ENABLED === "true" &&
		c.env.USER_REGISTRY &&
		!(await isAllowed(c.env.USER_REGISTRY, fid))
	) {
		return c.json(
			{ error: "NotAllowed", message: "This FID is not on the allowlist" },
			403,
		);
	}

	if (exists) {
		// Account exists — return tokens (activate only if deactivated, not deleted)
		const repoStatus = await accountDO.rpcGetRepoStatus();
		if (repoStatus.status === "deactivated") {
			await accountDO.rpcActivateAccount();
		}
		const identity = await accountDO.rpcGetAtprotoIdentity();
		const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
		const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);
		return c.json({
			accessJwt,
			refreshJwt,
			handle: identity?.handle ?? "",
			did,
			active: repoStatus.status !== "deleted",
		});
	}

	// Generate new signing keypair
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const signingKeyBytes = await keypair.export();
	const signingKey = Array.from(signingKeyBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const signingKeyPublic = keypair.did().replace("did:key:", "");

	try {
		await accountDO.rpcSetAtprotoIdentity({
			did,
			handle,
			signingKey,
			signingKeyPublic,
		});
	} catch (err) {
		// Race condition: identity was created between our check and set
		if (err instanceof Error && err.message.includes("already exists")) {
			await accountDO.rpcActivateAccount();
			const identity = await accountDO.rpcGetAtprotoIdentity();
			const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
			const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);
			return c.json({
				accessJwt,
				refreshJwt,
				handle: identity?.handle ?? "",
				did,
				active: true,
			});
		}
		throw err;
	}

	// Explicitly activate the account (ensures status is correct after deleteAll/recreation)
	await accountDO.rpcActivateAccount();

	// Emit identity event so relays and AppView refresh their DID document cache.
	try {
		await accountDO.rpcEmitIdentityEvent(handle);
	} catch {
		// Best-effort — don't fail account creation
	}

	// Register user in global registry (if D1 database is configured)
	if (c.env.USER_REGISTRY) {
		await registerUser(
			c.env.USER_REGISTRY,
			fid,
			signingKeyPublic,
			farcasterAddress,
		);
	}

	const accessJwt = await createAccessToken(c.env.JWT_SECRET, did, did);
	const refreshJwt = await createRefreshToken(c.env.JWT_SECRET, did, did);

	return c.json({
		accessJwt,
		refreshJwt,
		handle,
		did,
		active: true,
	});
}

/**
 * Advance the firehose seq floor past a given value.
 * Manual debug tool for fixing FutureCursor issues.
 *
 * POST /xrpc/is.fid.account.syncRelaySeq
 * Auth: Bearer token (requireAuth middleware)
 * Input: { seq: number }
 * Response: { success: true, newSeq: number }
 */
export async function syncRelaySeq(
	c: Context<AuthedAppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const did: string = c.get("did");
	const body = await c.req.json<{ seq: number }>().catch(() => null);

	if (!body?.seq || !Number.isInteger(body.seq) || body.seq <= 0) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing or invalid seq (must be a positive integer)",
			},
			400,
		);
	}

	const accountDO = getAccountDO(c.env, did);
	const result = await accountDO.rpcSyncRelaySeq(body.seq);

	return c.json({ success: true, newSeq: result.newSeq });
}

/**
 * Join the waitlist for account creation.
 *
 * POST /xrpc/is.fid.waitlist.join
 * Input: { farcasterToken: string } or SIWF credentials
 * Auth: Farcaster Quick Auth JWT or SIWF signature in request body
 *
 * Returns: { success: true, alreadyWaitlisted: boolean }
 */
export async function joinWaitlist(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	if (!c.env.USER_REGISTRY) {
		return c.json(
			{ error: "ServerError", message: "User registry not configured" },
			500,
		);
	}

	const body = await c.req.json<{
		farcasterToken?: string;
		message?: string;
		signature?: `0x${string}`;
		fid?: string;
		nonce?: string;
	}>().catch(() => null);

	if (!body) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid request body" },
			400,
		);
	}

	let fid: string;
	let farcasterAddress: string | undefined;

	if (body.farcasterToken) {
		// Quick Auth flow
		if (!c.env.QUICKAUTH_DOMAIN) {
			return c.json(
				{ error: "ServerError", message: "QUICKAUTH_DOMAIN not configured" },
				500,
			);
		}
		try {
			fid = await verifyQuickAuthToken(
				body.farcasterToken,
				c.env.QUICKAUTH_DOMAIN,
			);
		} catch (err) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: err instanceof Error ? err.message : "Invalid Farcaster authentication",
				},
				401,
			);
		}
	} else if (body.message && body.signature && body.fid && body.nonce) {
		// SIWF flow
		const domain = c.env.WEBFID_DOMAIN;
		try {
			({ fid, farcasterAddress } = await verifySiwfCredentials(
				body as { message: string; signature: `0x${string}`; fid: string; nonce: string },
				domain,
				c.env.ALCHEMY_API_KEY,
			));
		} catch (err) {
			if (err instanceof SiwfError) {
				return c.json({ error: err.code, message: err.message }, err.status as any);
			}
			throw err;
		}
	} else {
		return c.json(
			{ error: "InvalidRequest", message: "Missing authentication credentials" },
			400,
		);
	}

	const newlyInserted = await joinWaitlistDb(c.env.USER_REGISTRY, fid, farcasterAddress);

	return c.json({ success: true, alreadyWaitlisted: !newlyInserted });
}

/**
 * Delete the authenticated user's account.
 *
 * POST /xrpc/is.fid.account.delete
 * Auth: Bearer token (requireAuth middleware)
 *
 * This endpoint:
 * 1. Derives the FID from the authenticated DID
 * 2. Verifies the account exists
 * 3. Deletes R2 blobs and wipes DO storage
 * 4. Removes the D1 user registry entry
 */
export async function deleteAccount(
	c: Context<AuthedAppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const did: string = c.get("did");
	const domain = c.env.WEBFID_DOMAIN;
	const fid = didToFid(did, domain);

	if (!fid) {
		return c.json(
			{ error: "InvalidDID", message: "Cannot derive FID from DID" },
			400,
		);
	}

	const accountDO = getAccountDO(c.env, did);

	// Verify account exists
	const exists = await accountDO.rpcAccountExists();
	if (!exists) {
		return c.json(
			{ error: "AccountNotFound", message: "Account not found" },
			404,
		);
	}

	// Delete account (emits tombstone event, preserves minimal state)
	await accountDO.rpcDeleteRepo();

	// Delete from D1 user registry (best-effort — table may not exist)
	if (c.env.USER_REGISTRY) {
		try {
			await deleteUser(c.env.USER_REGISTRY, fid);
		} catch (err) {
			console.warn("Failed to delete user from registry:", err);
		}
	}

	return c.json({ success: true });
}
