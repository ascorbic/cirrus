import type { Context } from "hono";
import { hash as bcryptHash } from "bcryptjs";
import type { AccountDurableObject } from "../account-do";
import { createServiceJwt, getSigningKeypair } from "../service-auth";
import {
	createAccessToken,
	createRefreshToken,
	verifyPassword,
	verifyAccessToken,
	verifyRefreshToken,
	TokenExpiredError,
} from "../session";
import type { AppEnv, AuthedAppEnv } from "../types";

/**
 * Generate an AT Protocol app password in the format xxxx-xxxx-xxxx-xxxx.
 * Uses crypto.getRandomValues for secure randomness.
 */
function generateAppPassword(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz";
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const groups: string[] = [];
	for (let g = 0; g < 4; g++) {
		let segment = "";
		for (let i = 0; i < 4; i++) {
			segment += chars[bytes[g * 4 + i]! % chars.length];
		}
		groups.push(segment);
	}
	return groups.join("-");
}

/** Check if a string looks like an app password (xxxx-xxxx-xxxx-xxxx). */
function isAppPassword(password: string): boolean {
	return /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(password);
}

export async function describeServer(c: Context<AppEnv>): Promise<Response> {
	return c.json({
		did: c.env.DID,
		availableUserDomains: [],
		inviteCodeRequired: false,
	});
}

/**
 * Create a new session (login).
 * Accepts either the account password or an app password.
 */
export async function createSession(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json<{
		identifier: string;
		password: string;
	}>();

	const { identifier, password } = body;

	if (!identifier || !password) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing identifier or password",
			},
			400,
		);
	}

	// Check identifier matches handle or DID
	if (identifier !== c.env.HANDLE && identifier !== c.env.DID) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid identifier or password",
			},
			401,
		);
	}

	// Try app password first if it matches the format
	if (isAppPassword(password)) {
		const appPasswords = await accountDO.rpcGetAppPasswordHashes();
		let matched = false;
		for (const ap of appPasswords) {
			const valid = await verifyPassword(password, ap.passwordHash);
			if (valid) {
				matched = true;
				break;
			}
		}
		if (!matched) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid identifier or password",
				},
				401,
			);
		}
	} else {
		// Verify account password
		const passwordValid = await verifyPassword(
			password,
			c.env.PASSWORD_HASH,
		);
		if (!passwordValid) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid identifier or password",
				},
				401,
			);
		}
	}

	// Create tokens
	const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;
	const accessJwt = await createAccessToken(
		c.env.JWT_SECRET,
		c.env.DID,
		serviceDid,
	);
	const refreshJwt = await createRefreshToken(
		c.env.JWT_SECRET,
		c.env.DID,
		serviceDid,
	);

	const { email: storedEmail } = await accountDO.rpcGetEmail();
	const email = storedEmail || c.env.EMAIL;

	return c.json({
		accessJwt,
		refreshJwt,
		handle: c.env.HANDLE,
		did: c.env.DID,
		...(email ? { email } : {}),
		emailConfirmed: true,
		active: true,
	});
}

/**
 * Refresh a session
 */
export async function refreshSession(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
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
	const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

	try {
		const payload = await verifyRefreshToken(
			token,
			c.env.JWT_SECRET,
			serviceDid,
		);

		// Verify the subject matches our DID
		if (payload.sub !== c.env.DID) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid refresh token",
				},
				401,
			);
		}

		// Create new tokens
		const accessJwt = await createAccessToken(
			c.env.JWT_SECRET,
			c.env.DID,
			serviceDid,
		);
		const refreshJwt = await createRefreshToken(
			c.env.JWT_SECRET,
			c.env.DID,
			serviceDid,
		);

		const { email: storedEmail } = await accountDO.rpcGetEmail();
		const email = storedEmail || c.env.EMAIL;

		return c.json({
			accessJwt,
			refreshJwt,
			handle: c.env.HANDLE,
			did: c.env.DID,
			...(email ? { email } : {}),
			emailConfirmed: true,
			active: true,
		});
	} catch (err) {
		// Match official PDS: expired tokens return 'ExpiredToken', other errors return 'InvalidToken'
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
 * Get current session info
 */
export async function getSession(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
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
	const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

	// First try static token
	if (token === c.env.AUTH_TOKEN) {
		const { email: storedEmail } = await accountDO.rpcGetEmail();
		const email = storedEmail || c.env.EMAIL;
		return c.json({
			handle: c.env.HANDLE,
			did: c.env.DID,
			...(email ? { email } : {}),
			emailConfirmed: true,
			active: true,
		});
	}

	// Try JWT
	try {
		const payload = await verifyAccessToken(
			token,
			c.env.JWT_SECRET,
			serviceDid,
		);

		if (payload.sub !== c.env.DID) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid access token",
				},
				401,
			);
		}

		const { email: storedEmail } = await accountDO.rpcGetEmail();
		const email = storedEmail || c.env.EMAIL;
		return c.json({
			handle: c.env.HANDLE,
			did: c.env.DID,
			...(email ? { email } : {}),
			emailConfirmed: true,
			active: true,
		});
	} catch (err) {
		// Match official PDS: expired tokens return 400 with 'ExpiredToken'
		// This is required for clients to trigger automatic token refresh
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

/**
 * Delete current session (logout)
 */
export async function deleteSession(c: Context<AppEnv>): Promise<Response> {
	// For a single-user PDS with stateless JWTs, we don't need to do anything
	// The client just needs to delete its stored tokens
	// In a full implementation, we'd revoke the refresh token
	return c.json({});
}

/**
 * Get account status - used for migration checks and progress tracking
 */
export async function checkAccountStatus(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	try {
		// Check if repo exists and get activation state
		const status = await accountDO.rpcGetRepoStatus();
		const active = await accountDO.rpcGetActive();

		// Get counts for migration progress tracking
		const [repoBlocks, indexedRecords, expectedBlobs, importedBlobs] =
			await Promise.all([
				accountDO.rpcCountBlocks(),
				accountDO.rpcCountRecords(),
				accountDO.rpcCountExpectedBlobs(),
				accountDO.rpcCountImportedBlobs(),
			]);

		// Account is considered "activated" if it's currently active OR has content
		const activated = active || indexedRecords > 0;

		return c.json({
			activated,
			active,
			validDid: true,
			repoCommit: status.head,
			repoRev: status.rev,
			repoBlocks,
			indexedRecords,
			privateStateValues: null,
			expectedBlobs,
			importedBlobs,
		});
	} catch (err) {
		// If repo doesn't exist yet, return empty status
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
 * Get a service auth token for communicating with external services.
 * Used by clients to get JWTs for services like video.bsky.app.
 */
export async function getServiceAuth(
	c: Context<AuthedAppEnv>,
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

	// Create service JWT for the requested audience
	const keypair = await getSigningKeypair(c.env.SIGNING_KEY);
	const token = await createServiceJwt({
		iss: c.env.DID,
		aud,
		lxm,
		keypair,
	});

	return c.json({ token });
}

/**
 * Activate account - enables writes and firehose events
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
 * Deactivate account - disables writes while keeping reads available
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
 * Single-user PDS: no token needed, always returns tokenRequired: false.
 */
export async function requestEmailUpdate(
	c: Context<AuthedAppEnv>,
): Promise<Response> {
	return c.json({ tokenRequired: false });
}

/**
 * Request email confirmation.
 * Single-user PDS: email is always confirmed, nothing to do.
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

/**
 * Create an app password.
 * com.atproto.server.createAppPassword
 */
export async function createAppPassword(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json<{ name: string }>();

	if (!body.name || body.name.trim().length === 0) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required field: name",
			},
			400,
		);
	}

	const name = body.name.trim();

	// Check for duplicate names
	const existing = await accountDO.rpcListAppPasswords();
	if (existing.some((p) => p.name === name)) {
		return c.json(
			{
				error: "DuplicateName",
				message: `App password with name "${name}" already exists`,
			},
			400,
		);
	}

	const password = generateAppPassword();
	const passwordHash = await bcryptHash(password, 10);

	await accountDO.rpcSaveAppPassword(name, passwordHash);

	return c.json({
		name,
		password,
		createdAt: new Date().toISOString(),
	});
}

/**
 * List app passwords (names and dates, never the passwords themselves).
 * com.atproto.server.listAppPasswords
 */
export async function listAppPasswords(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const passwords = await accountDO.rpcListAppPasswords();
	return c.json({
		passwords: passwords.map((p) => ({
			name: p.name,
			createdAt: p.createdAt,
		})),
	});
}

/**
 * Revoke an app password by name.
 * com.atproto.server.revokeAppPassword
 */
export async function revokeAppPassword(
	c: Context<AuthedAppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json<{ name: string }>();

	if (!body.name) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required field: name",
			},
			400,
		);
	}

	const deleted = await accountDO.rpcDeleteAppPassword(body.name);
	if (!deleted) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `App password "${body.name}" not found`,
			},
			400,
		);
	}

	return c.json({});
}
