import type { Context, Next } from "hono";
import { verifyAccessToken } from "../session";
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

	if (!auth?.startsWith("Bearer ")) {
		return c.json(
			{
				error: "AuthMissing",
				message: "Authorization header required",
			},
			401,
		);
	}

	const token = auth.slice(7);

	// Try static token first (backwards compatibility)
	if (token === c.env.AUTH_TOKEN) {
		return next();
	}

	// Try JWT verification
	const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;
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
		c.set("auth", { did: payload.sub, scope: payload.scope });
		return next();
	} catch {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid authentication token",
			},
			401,
		);
	}
}
