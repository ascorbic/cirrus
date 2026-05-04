import type { Context, Next } from "hono";
import {
	ScopeMissingError,
	type ScopePermissionsTransition,
	permissionsFor,
} from "@getcirrus/oauth-provider";
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

/**
 * Legacy scope value produced by non-OAuth auth paths — session JWTs from
 * `createSession` (app-password flow), service JWTs from external services,
 * and the static `AUTH_TOKEN`. These predate the granular permission spec
 * and represent fully-trusted callers, so scope checks short-circuit to
 * allow.
 *
 * `com.atproto.refresh` is intentionally NOT in this set: refresh tokens
 * should never reach a resource handler (only `/oauth/token` and
 * `/com.atproto.server.refreshSession` accept them, both with their own
 * verifiers). If one ever leaks here, fail closed.
 */
const LEGACY_FULL_TRUST_SCOPES = new Set(["com.atproto.access"]);

/**
 * Build a scope checker pre-bound to the request's auth context. Returns a
 * function that accepts a `(perms) => void` callback (typically calling
 * `assertRepo` / `assertRpc` etc.) and returns a 403 Response on failure
 * or null on success. The underlying ScopePermissionsTransition is built
 * once and reused, so loops (e.g. applyWrites) don't pay re-parse cost.
 *
 * Returns null when the request was authenticated by a legacy fully-trusted
 * path (session JWT, static AUTH_TOKEN, service JWT) so callers can skip
 * scope checks entirely.
 */
export function buildScopeChecker(
	c: Context<{ Bindings: PDSEnv; Variables: AuthVariables }>,
): ((check: (perms: ScopePermissionsTransition) => void) => Response | null) | null {
	const auth = c.get("auth");
	if (!auth?.scope) return null;
	if (LEGACY_FULL_TRUST_SCOPES.has(auth.scope)) return null;
	const perms = permissionsFor(auth.scope);
	return (check) => {
		try {
			check(perms);
			return null;
		} catch (err) {
			if (err instanceof ScopeMissingError) {
				return c.json(
					{
						error: "InsufficientScope",
						message: `Missing required scope: ${err.scope}`,
					},
					403,
				);
			}
			throw err;
		}
	};
}

/**
 * Run a scope check against the authenticated request's token. Returns a 403
 * Response when the scope is missing, or null when the check passes.
 *
 * Use inside an XRPC handler after data-driven values (collection name, MIME
 * type, etc.) become available from the request body. For loops, prefer
 * {@link buildScopeChecker} which hoists the parse out of the hot path.
 */
export function requireScope(
	c: Context<{ Bindings: PDSEnv; Variables: AuthVariables }>,
	check: (perms: ScopePermissionsTransition) => void,
): Response | null {
	const checker = buildScopeChecker(c);
	if (!checker) return null;
	return checker(check);
}

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

	// Try static token first (backwards compatibility). The static token is a
	// shared operator secret; requireScope() treats `com.atproto.access` as a
	// fully-trusted legacy scope, so this carries the same broad authority.
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

		// Service JWTs carry an optional `lxm` claim binding them to a single
		// XRPC method. If present, enforce it against the actual request path —
		// otherwise a JWT issued for one method could be replayed against
		// another. Reject when the request isn't an XRPC call at all.
		if (payload.lxm) {
			const xrpcPrefix = "/xrpc/";
			const path = new URL(c.req.url).pathname;
			if (!path.startsWith(xrpcPrefix)) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: "Service JWT used outside an XRPC method call",
					},
					401,
				);
			}
			// Strip a single optional trailing slash and reject double-slash
			// or empty segments — keeps the comparison robust against URL
			// normalisation quirks without admitting path-traversal cousins.
			const rest = path.slice(xrpcPrefix.length);
			const requestedLxm = rest.endsWith("/") ? rest.slice(0, -1) : rest;
			if (
				!requestedLxm ||
				requestedLxm.includes("/") ||
				requestedLxm !== payload.lxm
			) {
				return c.json(
					{
						error: "AuthenticationRequired",
						message: `Service JWT bound to ${payload.lxm}, not ${requestedLxm}`,
					},
					401,
				);
			}
		}

		// Store auth info in context. Service JWTs that pass verification
		// represent a fully-authenticated caller bound to one method (above);
		// mark with the legacy `com.atproto.access` scope so requireScope()
		// short-circuits at the resource layer.
		c.set("auth", { did: payload.iss, scope: "com.atproto.access" });
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
