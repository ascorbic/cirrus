/**
 * OAuth 2.1 integration for the PDS
 *
 * Connects the @getcirrus/oauth-provider package with the PDS
 * by providing storage through Durable Objects and user authentication
 * through passkeys.
 *
 * In the per-user subdomain architecture, each user's PDS is at NNN.fid.is,
 * so OAuth storage and identity are always routed to that user's DO.
 */

import { Hono, type Context } from "hono";
import { ATProtoOAuthProvider } from "@getcirrus/oauth-provider";
import type {
	OAuthStorage,
	AuthCodeData,
	TokenData,
	ClientMetadata,
	PARData,
} from "@getcirrus/oauth-provider";
import type { PDSEnv } from "./types";
import type { AccountDurableObject } from "./account-do";
import {
	hostnameToFid,
	fidToDid,
	fidToHandle,
} from "./farcaster-auth";
import {
	getAuthenticationOptions,
	verifyPasskeyAuthentication,
	type AuthenticationResponseJSON,
} from "./passkey";
import { createAppClient, viemConnector } from "@farcaster/auth-client";

/**
 * Proxy storage class that delegates to DO RPC methods
 *
 * This is needed because SqliteOAuthStorage instances contain a SQL connection
 * that can't be serialized across the DO RPC boundary. Instead, we delegate each
 * storage operation to individual RPC methods that pass only serializable data.
 */
class DOProxyOAuthStorage implements OAuthStorage {
	constructor(private accountDO: DurableObjectStub<AccountDurableObject>) {}

	async saveAuthCode(code: string, data: AuthCodeData): Promise<void> {
		await this.accountDO.rpcSaveAuthCode(code, data);
	}

	async getAuthCode(code: string): Promise<AuthCodeData | null> {
		return this.accountDO.rpcGetAuthCode(code);
	}

	async deleteAuthCode(code: string): Promise<void> {
		await this.accountDO.rpcDeleteAuthCode(code);
	}

	async saveTokens(data: TokenData): Promise<void> {
		await this.accountDO.rpcSaveTokens(data);
	}

	async getTokenByAccess(accessToken: string): Promise<TokenData | null> {
		return this.accountDO.rpcGetTokenByAccess(accessToken);
	}

	async getTokenByRefresh(refreshToken: string): Promise<TokenData | null> {
		return this.accountDO.rpcGetTokenByRefresh(refreshToken);
	}

	async revokeToken(accessToken: string): Promise<void> {
		await this.accountDO.rpcRevokeToken(accessToken);
	}

	async revokeAllTokens(sub: string): Promise<void> {
		await this.accountDO.rpcRevokeAllTokens(sub);
	}

	async saveClient(clientId: string, metadata: ClientMetadata): Promise<void> {
		await this.accountDO.rpcSaveClient(clientId, metadata);
	}

	async getClient(clientId: string): Promise<ClientMetadata | null> {
		return this.accountDO.rpcGetClient(clientId);
	}

	async savePAR(requestUri: string, data: PARData): Promise<void> {
		await this.accountDO.rpcSavePAR(requestUri, data);
	}

	async getPAR(requestUri: string): Promise<PARData | null> {
		return this.accountDO.rpcGetPAR(requestUri);
	}

	async deletePAR(requestUri: string): Promise<void> {
		await this.accountDO.rpcDeletePAR(requestUri);
	}

	async checkAndSaveNonce(nonce: string): Promise<boolean> {
		return this.accountDO.rpcCheckAndSaveNonce(nonce);
	}
}

/** Context for OAuth operations extracted from request hostname */
interface OAuthContext {
	fid: string;
	did: string;
	handle: string;
	hostname: string;
	accountDO: DurableObjectStub<AccountDurableObject>;
}

// Type for the getAccountDO function
type GetAccountDO = (env: PDSEnv, did: string) => DurableObjectStub<AccountDurableObject>;

/**
 * Extract OAuth context from request hostname.
 * Returns null if the hostname is not a valid WebFID subdomain.
 */
function getOAuthContext(
	hostname: string,
	getAccountDO: GetAccountDO,
	env: PDSEnv,
): OAuthContext | null {
	const domain = env.WEBFID_DOMAIN;
	const fid = hostnameToFid(hostname, domain);
	if (fid === null) {
		return null;
	}

	const did = fidToDid(fid, domain);
	const handle = fidToHandle(fid, domain);
	const accountDO = getAccountDO(env, did);

	return { fid, did, handle, hostname, accountDO };
}

/**
 * Create an OAuth provider for a specific user context.
 * The provider is configured with the user's storage and identity.
 */
function createProvider(ctx: OAuthContext): ATProtoOAuthProvider {
	const storage = new DOProxyOAuthStorage(ctx.accountDO);
	const issuer = `https://${ctx.hostname}`;

	return new ATProtoOAuthProvider({
		storage,
		issuer,
		dpopRequired: true,
		enablePAR: true,
		// Password auth is not supported in multi-tenant mode
		verifyUser: undefined,
		// SIWF (Sign In With Farcaster) authentication
		verifySiwf: async (message: string, signature: string, fid: string, nonce: string) => {
			try {
				const appClient = createAppClient({ ethereum: viemConnector() });
				const verifyResult = await appClient.verifySignInMessage({
					message,
					signature: signature as `0x${string}`,
					domain: ctx.hostname,
					nonce,
				});
				if (!verifyResult.success) {
					console.error("SIWF verify failed:", JSON.stringify(verifyResult));
					return null;
				}
				if (String(verifyResult.fid) !== ctx.fid) {
					console.error(`SIWF FID mismatch: got ${verifyResult.fid}, expected ${ctx.fid}`);
					return null;
				}
				return { sub: ctx.did, handle: ctx.handle };
			} catch (e) {
				console.error("SIWF verification error:", e);
				return null;
			}
		},
		// Passkey authentication options
		getPasskeyOptions: async (): Promise<Record<string, unknown> | null> => {
			const options = await getAuthenticationOptions(ctx.accountDO, ctx.hostname);
			return options as Record<string, unknown> | null;
		},
		// Passkey verification
		verifyPasskey: async (response, challenge: string) => {
			const result = await verifyPasskeyAuthentication(
				ctx.accountDO,
				ctx.hostname,
				response as AuthenticationResponseJSON,
				challenge,
			);
			if (!result.success) return null;
			return {
				sub: ctx.did,
				handle: ctx.handle,
			};
		},
	});
}

/**
 * Get the OAuth provider for the given request.
 * Exported for use in auth middleware for DPoP token verification.
 */
export function getProviderForRequest(
	request: Request,
	getAccountDO: GetAccountDO,
	env: PDSEnv,
): ATProtoOAuthProvider | null {
	const hostname = new URL(request.url).hostname;
	const ctx = getOAuthContext(hostname, getAccountDO, env);
	if (!ctx) return null;
	return createProvider(ctx);
}

/** Hono app environment for OAuth routes */
type OAuthAppEnv = { Bindings: PDSEnv };

/** Error response for invalid hostname */
function invalidHostnameError(c: Context<OAuthAppEnv>): Response {
	return c.json(
		{
			error: "invalid_request",
			error_description: "Invalid hostname for OAuth",
		},
		400,
	);
}

/**
 * Create OAuth routes for the PDS
 *
 * This creates a Hono sub-app with all OAuth endpoints:
 * - GET /.well-known/oauth-authorization-server - Server metadata
 * - GET /oauth/authorize - Authorization endpoint
 * - POST /oauth/authorize - Handle authorization consent
 * - POST /oauth/token - Token endpoint
 * - POST /oauth/par - Pushed Authorization Request
 *
 * In per-user subdomain mode, each subdomain (NNN.fid.is) serves its own OAuth endpoints.
 *
 * @param accountDOGetter Function to get the account DO stub for a given DID
 */
export function createOAuthApp(accountDOGetter: GetAccountDO) {
	const oauth = new Hono<OAuthAppEnv>();

	// Helper to get OAuth context from request
	const getCtx = (c: Context<OAuthAppEnv>): OAuthContext | null => {
		const hostname = new URL(c.req.url).hostname;
		return getOAuthContext(hostname, accountDOGetter, c.env);
	};

	// OAuth server metadata
	oauth.get("/.well-known/oauth-authorization-server", (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handleMetadata();
	});

	// Protected resource metadata (for token introspection discovery)
	oauth.get("/.well-known/oauth-protected-resource", (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const issuer = `https://${ctx.hostname}`;
		return c.json({
			resource: issuer,
			authorization_servers: [issuer],
			scopes_supported: [
				"atproto",
				"transition:generic",
				"transition:chat.bsky",
			],
		});
	});

	// Authorization endpoint
	oauth.get("/oauth/authorize", async (c) => {
		// Messaging platform link preview bots pre-fetch URLs shared in DMs and
		// channels, which consumes the one-time PAR request URI before the user
		// can open it. Return a minimal HTML page for known preview bots instead
		// of processing the OAuth request. Only specific messaging platforms are
		// matched — generic crawlers and spiders should consume the token since
		// an unknown bot hitting an OAuth URL is legitimately suspicious.
		const ua = c.req.header("User-Agent") ?? "";
		if (
			/TelegramBot|Slackbot|Discordbot|Twitterbot|facebookexternalhit|WhatsApp/i.test(
				ua,
			)
		) {
			return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Cirrus Authorization</title>
	<meta name="description" content="Cirrus PDS authorization page. Open this link in your browser to continue.">
	<meta property="og:title" content="Cirrus Authorization">
	<meta property="og:description" content="Open this link in your browser to continue.">
</head>
<body>
	<p>Open this link in your browser to continue.</p>
</body>
</html>`);
		}
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handleAuthorize(c.req.raw);
	});

	oauth.post("/oauth/authorize", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handleAuthorize(c.req.raw);
	});

	// Passkey authentication endpoint
	oauth.post("/oauth/passkey-auth", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handlePasskeyAuth(c.req.raw);
	});

	// SIWF authentication endpoint
	oauth.post("/oauth/siwf-auth", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handleSiwfAuth(c.req.raw);
	});

	// Token endpoint
	oauth.post("/oauth/token", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handleToken(c.req.raw);
	});

	// Pushed Authorization Request endpoint
	oauth.post("/oauth/par", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		return provider.handlePAR(c.req.raw);
	});

	// UserInfo endpoint (OpenID Connect)
	// Returns user claims for the authenticated user
	oauth.get("/oauth/userinfo", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);
		const provider = createProvider(ctx);
		const tokenData = await provider.verifyAccessToken(c.req.raw);

		if (!tokenData) {
			return c.json(
				{ error: "invalid_token", error_description: "Invalid or expired token" },
				401,
			);
		}

		// Return OpenID Connect userinfo response
		// sub is required, we also include preferred_username (handle)
		return c.json({
			sub: tokenData.sub,
			preferred_username: ctx.handle,
		});
	});

	// Token revocation endpoint
	oauth.post("/oauth/revoke", async (c) => {
		const ctx = getCtx(c);
		if (!ctx) return invalidHostnameError(c);

		// Parse the token from the request
		// RFC 7009 requires application/x-www-form-urlencoded, we also accept JSON
		const contentType = c.req.header("Content-Type") ?? "";
		let token: string | undefined;

		try {
			if (contentType.includes("application/json")) {
				const json = await c.req.json();
				token = json.token;
			} else if (contentType.includes("application/x-www-form-urlencoded")) {
				const body = await c.req.text();
				const params = Object.fromEntries(new URLSearchParams(body).entries());
				token = params.token;
			} else if (!contentType) {
				// No Content-Type: treat as empty body (no token)
				token = undefined;
			} else {
				return c.json(
					{
						error: "invalid_request",
						error_description:
							"Content-Type must be application/x-www-form-urlencoded (per RFC 7009) or application/json",
					},
					400,
				);
			}
		} catch {
			return c.json(
				{ error: "invalid_request", error_description: "Failed to parse request body" },
				400,
			);
		}

		if (!token) {
			// Per RFC 7009, return 200 even if no token provided
			return c.json({});
		}

		// Try to revoke the token (RFC 7009 accepts both access and refresh tokens)
		// First try as access token
		await ctx.accountDO.rpcRevokeToken(token);

		// Also check if it's a refresh token and revoke the associated access token
		const tokenData = await ctx.accountDO.rpcGetTokenByRefresh(token);
		if (tokenData) {
			await ctx.accountDO.rpcRevokeToken(tokenData.accessToken);
		}

		// Always return success (per RFC 7009)
		return c.json({});
	});

	return oauth;
}
