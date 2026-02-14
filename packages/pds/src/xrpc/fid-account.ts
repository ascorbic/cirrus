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
import { registerUser } from "../user-registry";

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

	// Derive DID and handle from FID (deterministic)
	// WEBFID_DOMAIN is the PDS domain used for DID/handle generation
	const did = fidToDid(fid, c.env.WEBFID_DOMAIN);
	const handle = fidToHandle(fid, c.env.WEBFID_DOMAIN);

	// Get the account's Durable Object (route by DID)
	const accountDO = getAccountDO(c.env, did);

	// Check if account already exists - if so, just return session tokens
	// This makes account creation idempotent and handles race conditions from React Strict Mode
	const exists = await accountDO.rpcHasAtprotoIdentity();
	if (exists) {
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

	// Generate new signing keypair
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const signingKeyBytes = await keypair.export();
	// Convert to hex string (Cloudflare Workers compatible)
	const signingKey = Array.from(signingKeyBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const signingKeyPublic = keypair.did().replace("did:key:", "");

	// Store credentials in DO
	// Handle race condition: if identity was created by concurrent request, return success anyway
	try {
		await accountDO.rpcSetAtprotoIdentity({
			did,
			handle,
			signingKey,
			signingKeyPublic,
		});
	} catch (err) {
		// Race condition: identity was created between our check and set
		// This is fine - just return session tokens for the existing account
		if (err instanceof Error && err.message.includes("already exists")) {
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

	// Derive DID and handle from FID (deterministic)
	const did = fidToDid(fid, c.env.WEBFID_DOMAIN);
	const handle = fidToHandle(fid, c.env.WEBFID_DOMAIN);

	// Get the account's Durable Object (route by DID)
	const accountDO = getAccountDO(c.env, did);

	// Check if account exists
	const exists = await accountDO.rpcHasAtprotoIdentity();
	if (!exists) {
		return c.json(
			{
				error: "AccountNotFound",
				message: `No account found for FID ${fid}. Use is.fid.account.create first.`,
			},
			404,
		);
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
 * Login or create account with Sign In With Farcaster (SIWF).
 *
 * POST /xrpc/is.fid.auth.siwf
 * Input: { message: string, signature: string, fid: number, nonce: string }
 *
 * This endpoint verifies a SIWF signature and creates/logs in the account.
 * Used for browser-based authentication where Quick Auth isn't available.
 */
export async function loginWithSiwf(
	c: Context<AppEnv>,
	getAccountDO: GetAccountDO,
): Promise<Response> {
	const body = await c.req
		.json<{
			message: string;
			signature: `0x${string}`;
			fid: number;
			nonce: string;
		}>()
		.catch(() => null);

	if (!body?.message || !body?.signature || !body?.fid || !body?.nonce) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required fields: message, signature, fid, nonce",
			},
			400,
		);
	}

	// Get domain from environment
	const domain = c.env.WEBFID_DOMAIN;

	// Create Farcaster auth client for verification
	const appClient = createAppClient({
		ethereum: viemConnector(),
	});

	// Verify the SIWF signature
	const verifyResult = await appClient.verifySignInMessage({
		message: body.message,
		signature: body.signature,
		domain,
		nonce: body.nonce,
	});

	if (!verifyResult.success) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid SIWF signature",
			},
			401,
		);
	}

	// Verify the FID matches
	if (Number(verifyResult.fid) !== body.fid) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "FID mismatch",
			},
			401,
		);
	}

	const fid = body.fid.toString();

	// Derive DID and handle from FID
	const did = fidToDid(fid, domain);
	const handle = fidToHandle(fid, domain);

	// Get the account's Durable Object
	const accountDO = getAccountDO(c.env, did);

	// Check if account exists
	const existingAccount = await accountDO.rpcHasAtprotoIdentity();
	let isNew = false;

	// Extract custody address from SIWF verification result
	const farcasterAddress =
		"address" in verifyResult ? (verifyResult.address as string) : undefined;

	if (!existingAccount) {
		// Create new account
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const signingKeyBytes = await keypair.export();
		const signingKey = Array.from(signingKeyBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const signingKeyPublic = keypair.did().replace("did:key:", "");

		await accountDO.rpcSetAtprotoIdentity({
			did,
			handle,
			signingKey,
			signingKeyPublic,
		});

		// Register user in global registry (if D1 database is configured)
		if (c.env.USER_REGISTRY) {
			await registerUser(
				c.env.USER_REGISTRY,
				fid,
				signingKeyPublic,
				farcasterAddress,
			);
		}

		isNew = true;
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
		isNew,
	});
}
