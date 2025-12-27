import type { Context } from "hono";
import { ensureValidHandle } from "@atproto/syntax";
import {
	createAccessToken,
	createRefreshToken,
	verifyPassword,
	verifyAccessToken,
	verifyRefreshToken,
} from "../session";

export async function describeServer(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	return c.json({
		did: c.env.DID,
		availableUserDomains: [],
		inviteCodeRequired: false,
	});
}

export async function resolveHandle(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const handle = c.req.query("handle");

	if (!handle) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: handle",
			},
			400,
		);
	}

	// Validate handle format
	try {
		ensureValidHandle(handle);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid handle format: ${err instanceof Error ? err.message : String(err)}`,
			},
			400,
		);
	}

	if (handle !== c.env.HANDLE) {
		return c.json(
			{
				error: "HandleNotFound",
				message: `Handle not found: ${handle}`,
			},
			404,
		);
	}

	return c.json({
		did: c.env.DID,
	});
}

/**
 * Create a new session (login)
 */
export async function createSession(
	c: Context<{ Bindings: Env }>,
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

	// Verify password
	if (!c.env.PASSWORD_HASH) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Password authentication not configured",
			},
			500,
		);
	}

	const passwordValid = await verifyPassword(password, c.env.PASSWORD_HASH);
	if (!passwordValid) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid identifier or password",
			},
			401,
		);
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

	return c.json({
		accessJwt,
		refreshJwt,
		handle: c.env.HANDLE,
		did: c.env.DID,
		active: true,
	});
}

/**
 * Refresh a session
 */
export async function refreshSession(
	c: Context<{ Bindings: Env }>,
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

		return c.json({
			accessJwt,
			refreshJwt,
			handle: c.env.HANDLE,
			did: c.env.DID,
			active: true,
		});
	} catch (err) {
		return c.json(
			{
				error: "ExpiredToken",
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
	c: Context<{ Bindings: Env }>,
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
		return c.json({
			handle: c.env.HANDLE,
			did: c.env.DID,
			active: true,
		});
	}

	// Try JWT
	try {
		const payload = await verifyAccessToken(token, c.env.JWT_SECRET, serviceDid);

		if (payload.sub !== c.env.DID) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid access token",
				},
				401,
			);
		}

		return c.json({
			handle: c.env.HANDLE,
			did: c.env.DID,
			active: true,
		});
	} catch (err) {
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
export async function deleteSession(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	// For a single-user PDS with stateless JWTs, we don't need to do anything
	// The client just needs to delete its stored tokens
	// In a full implementation, we'd revoke the refresh token
	return c.json({});
}
