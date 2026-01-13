import type { Context, Next } from "hono";
import { verifyServiceJwt } from "../service-auth";
import { verifyAccessToken, TokenExpiredError } from "../session";
import { getProvider } from "../oauth";
import type { PDSEnv } from "../types";

export interface AuthInfo {
	did: string;
	scope: string;
}

export type AuthVariables = {
	auth: AuthInfo;
};

export async function requireAuth(
	c: Context<{ Bindings: PDSEnv; Variables: AuthVariables }>,
	next: Next,
): Promise<Response | void> {
	const auth = c.req.header("Authorization");

	if (!auth) {
		return c.json(
			{
				error: "AuthMissing",
				message: "Authorization header required",
			},
			401,
		);
	}

	// Handle DPoP-bound OAuth tokens
	if (auth.startsWith("DPoP ")) {
		const provider = getProvider(c.env);

		// Verify OAuth access token with DPoP proof
		const tokenData = await provider.verifyAccessToken(c.req.raw);
		if (!tokenData) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid OAuth access token",
				},
				401,
			);
		}

		c.set("auth", { did: tokenData.sub, scope: tokenData.scope });
		return next();
	}

	// Handle Bearer tokens (session JWTs, static token, service JWTs)
	if (!auth.startsWith("Bearer ")) {
		return c.json(
			{
				error: "AuthMissing",
				message: "Invalid authorization scheme",
			},
			401,
		);
	}

	const token = auth.slice(7);

	// Try static token first (backwards compatibility)
	if (token === c.env.AUTH_TOKEN) {
		c.set("auth", { did: c.env.DID, scope: "com.atproto.access" });
		return next();
	}

	const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

	// Try session JWT verification (HS256, signed with JWT_SECRET)
	// Used by Bluesky app for normal operations (posts, likes, etc.)
	try {
		const payload = await verifyAccessToken(
			token,
			c.env.JWT_SECRET,
			serviceDid,
		);

		// Verify subject matches our DID
		if (payload.sub !== c.env.DID) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid access token",
				},
				401,
			);
		}

		// Store auth info in context for downstream use
		c.set("auth", { did: payload.sub, scope: payload.scope as string });
		return next();
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
		// Session JWT verification failed for other reasons, try service JWT
	}

	// Try service JWT verification (ES256K, signed with our signing key)
	// Used by external services (like video.bsky.app) calling back to our PDS
	try {
		const payload = await verifyServiceJwt(
			token,
			c.env.SIGNING_KEY,
			serviceDid, // audience should be our PDS
			c.env.DID, // issuer should be the user's DID
		);

		// Store auth info in context
		c.set("auth", { did: payload.iss, scope: payload.lxm || "atproto" });
		return next();
	} catch {
		// Service JWT verification also failed
	}

	return c.json(
		{
			error: "AuthenticationRequired",
			message: "Invalid authentication token",
		},
		401,
	);
}
