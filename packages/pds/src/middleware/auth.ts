/**
 * Authentication middleware for multi-tenant PDS.
 *
 * Verifies session JWTs and extracts the DID from the JWT subject claim.
 * The JWT audience is derived from the request hostname.
 */

import type { Context, Next } from "hono";
import { verifyAccessToken, TokenExpiredError } from "../session";
import { hostnameToFid, fidToDid } from "../farcaster-auth";
import type { PDSEnv } from "../types";

/** Variables set by the auth middleware */
export type AuthVariables = {
	/** The authenticated user's DID */
	did: string;
};

/**
 * Middleware that requires authentication.
 * Verifies the session JWT and extracts DID from the subject claim.
 */
export async function requireAuth(
	c: Context<{
		Bindings: PDSEnv;
		Variables: Partial<AuthVariables>;
	}>,
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

	// Only support Bearer tokens (session JWTs)
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

	// Derive service DID from request hostname for JWT audience verification.
	// Hostname patterns:
	// 1. User subdomain (NNN.fid.is) → audience = did:web:NNN.fid.is (enforced)
	// 2. Management host (my.fid.is or base domain) → audience not checked
	//    (tokens have aud = user's PDS DID; management endpoints only need sub claim)
	// 3. Unknown hostnames → rejected
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const fid = hostnameToFid(hostname, domain);

	let serviceDid: string | undefined;
	if (fid) {
		// User subdomain (123.fid.is) → audience must match the user's PDS service DID
		serviceDid = fidToDid(fid, domain);
	} else if (hostname === `my.${domain}` || hostname === domain) {
		// Management host → verify signature/expiry but skip audience check.
		// Matches both my.fid.is (production) and the bare domain (dev tunnels
		// where sub-subdomains aren't available).
		serviceDid = undefined;
	} else {
		return c.json(
			{
				error: "AuthMissing",
				message: "Invalid hostname for authentication",
			},
			401,
		);
	}

	try {
		const payload = await verifyAccessToken(
			token,
			c.env.JWT_SECRET,
			serviceDid,
		);

		const did = payload.sub;
		if (!did) {
			return c.json(
				{
					error: "AuthenticationRequired",
					message: "Invalid access token - missing subject",
				},
				401,
			);
		}

		// Store DID in context for handlers
		c.set("did", did);

		return next();
	} catch (err) {
		// Match official PDS: expired tokens return 400 with 'ExpiredToken'
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
				error: "AuthenticationRequired",
				message: "Invalid authentication token",
			},
			401,
		);
	}
}
