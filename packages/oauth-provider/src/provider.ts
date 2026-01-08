/**
 * Core OAuth 2.1 Provider with AT Protocol extensions
 * Orchestrates authorization code flow with PKCE, DPoP, and PAR
 */

import type { OAuthAuthorizationServerMetadata } from "@atproto/oauth-types";
import type { OAuthStorage, AuthCodeData, TokenData, ClientMetadata } from "./storage.js";
import { verifyPkceChallenge } from "./pkce.js";
import { verifyDpopProof, DpopError, generateDpopNonce } from "./dpop.js";
import { PARHandler } from "./par.js";
import { ClientResolver } from "./client-resolver.js";
import {
	generateAuthCode,
	generateTokens,
	refreshTokens,
	buildTokenResponse,
	extractAccessToken,
	isTokenValid,
	AUTH_CODE_TTL,
} from "./tokens.js";
import { renderConsentUI, renderErrorPage, getConsentUiCsp } from "./ui.js";
import { authenticateClient, ClientAuthError } from "./client-auth.js";

/** Passkey authentication response from the browser */
export interface PasskeyAuthResponse {
	id: string;
	rawId: string;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	type: string;
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: string;
}

/**
 * OAuth provider configuration
 */
export interface OAuthProviderConfig {
	/** OAuth storage implementation */
	storage: OAuthStorage;
	/** The OAuth issuer URL (e.g., https://your-pds.com) */
	issuer: string;
	/** Whether DPoP is required for all tokens (default: true for AT Protocol) */
	dpopRequired?: boolean;
	/** Whether PAR is enabled (default: true) */
	enablePAR?: boolean;
	/** Client resolver for DID-based discovery */
	clientResolver?: ClientResolver;
	/** Callback to verify user credentials */
	verifyUser?: (password: string) => Promise<{ sub: string; handle: string } | null>;
	/** Get the current user (if already authenticated) */
	getCurrentUser?: () => Promise<{ sub: string; handle: string } | null>;
	/** Get passkey authentication options (returns null if no passkeys are registered) */
	getPasskeyOptions?: () => Promise<Record<string, unknown> | null>;
	/** Verify passkey authentication */
	verifyPasskey?: (response: PasskeyAuthResponse, challenge: string) => Promise<{ sub: string; handle: string } | null>;
}

/**
 * OAuth error response builder
 */
function oauthError(error: string, description: string, status: number = 400): Response {
	return new Response(
		JSON.stringify({
			error,
			error_description: description,
		}),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		}
	);
}

/**
 * Error thrown when request body parsing fails
 */
export class RequestBodyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestBodyError";
	}
}

/**
 * Parse request body from JSON or form-urlencoded
 * @throws RequestBodyError if content type is unsupported or parsing fails
 */
export async function parseRequestBody(request: Request): Promise<Record<string, string>> {
	const contentType = request.headers.get("Content-Type") ?? "";

	try {
		if (contentType.includes("application/json")) {
			const json = await request.json();
			return Object.fromEntries(
				Object.entries(json as Record<string, unknown>).map(([k, v]) => [k, String(v)])
			);
		} else if (contentType.includes("application/x-www-form-urlencoded")) {
			const body = await request.text();
			return Object.fromEntries(new URLSearchParams(body).entries());
		} else {
			throw new RequestBodyError(
				"Content-Type must be application/json or application/x-www-form-urlencoded"
			);
		}
	} catch (e) {
		if (e instanceof RequestBodyError) {
			throw e;
		}
		throw new RequestBodyError("Failed to parse request body");
	}
}

/**
 * AT Protocol OAuth 2.1 Provider
 */
export class ATProtoOAuthProvider {
	private storage: OAuthStorage;
	private issuer: string;
	private dpopRequired: boolean;
	private enablePAR: boolean;
	private parHandler: PARHandler;
	private clientResolver: ClientResolver;
	private verifyUser?: (password: string) => Promise<{ sub: string; handle: string } | null>;
	private getCurrentUser?: () => Promise<{ sub: string; handle: string } | null>;
	private getPasskeyOptions?: () => Promise<Record<string, unknown> | null>;
	private verifyPasskey?: (response: PasskeyAuthResponse, challenge: string) => Promise<{ sub: string; handle: string } | null>;

	constructor(config: OAuthProviderConfig) {
		this.storage = config.storage;
		this.issuer = config.issuer;
		this.dpopRequired = config.dpopRequired ?? true;
		this.enablePAR = config.enablePAR ?? true;
		this.parHandler = new PARHandler(config.storage, config.issuer);
		this.clientResolver = config.clientResolver ?? new ClientResolver({ storage: config.storage });
		this.verifyUser = config.verifyUser;
		this.getCurrentUser = config.getCurrentUser;
		this.getPasskeyOptions = config.getPasskeyOptions;
		this.verifyPasskey = config.verifyPasskey;
	}

	/**
	 * Handle authorization request (GET/POST /oauth/authorize)
	 */
	async handleAuthorize(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Parse OAuth params from query string (GET) or form data (POST)
		let params: Record<string, string>;

		if (request.method === "POST") {
			// POST: parse from form data (includes hidden fields with OAuth params)
			const formData = await request.formData();
			params = {};
			for (const [key, value] of formData.entries()) {
				if (typeof value === "string") {
					params[key] = value;
				}
			}
		} else {
			// GET: check for PAR or query params
			const requestUri = url.searchParams.get("request_uri");
			const clientId = url.searchParams.get("client_id");

			if (requestUri && this.enablePAR) {
				if (!clientId) {
					return await this.renderError("invalid_request", "client_id required with request_uri");
				}
				const parParams = await this.parHandler.retrieveParams(requestUri, clientId);
				if (!parParams) {
					return await this.renderError("invalid_request", "Invalid or expired request_uri");
				}
				params = parParams;
			} else if (this.enablePAR) {
				// PAR is required when enabled - reject direct authorization requests
				return await this.renderError(
					"invalid_request",
					"Pushed Authorization Request required. Use the PAR endpoint first."
				);
			} else {
				// Parse query parameters (only when PAR is not enabled)
				params = Object.fromEntries(url.searchParams.entries());
			}
		}

		// Validate required parameters
		const required = ["client_id", "redirect_uri", "response_type", "code_challenge", "state"];
		for (const param of required) {
			if (!params[param]) {
				return await this.renderError("invalid_request", `Missing required parameter: ${param}`);
			}
		}

		// Validate response_type
		if (params.response_type !== "code") {
			return await this.renderError("unsupported_response_type", "Only response_type=code is supported");
		}

		// Validate code_challenge_method
		if (params.code_challenge_method && params.code_challenge_method !== "S256") {
			return await this.renderError("invalid_request", "Only code_challenge_method=S256 is supported");
		}

		// Resolve client metadata
		let client: ClientMetadata;
		try {
			client = await this.clientResolver.resolveClient(params.client_id!);
		} catch (e) {
			return await this.renderError("invalid_client", `Failed to resolve client: ${e}`);
		}

		// Validate redirect_uri
		if (!client.redirectUris.includes(params.redirect_uri!)) {
			return await this.renderError("invalid_request", "Invalid redirect_uri for this client");
		}

		// Handle POST (form submission)
		if (request.method === "POST") {
			return this.handleAuthorizePost(request, params, client);
		}

		// Check if user is authenticated
		let user: { sub: string; handle: string } | null = null;
		if (this.getCurrentUser) {
			user = await this.getCurrentUser();
		}

		// Get passkey options if user needs to log in
		let passkeyOptions: Record<string, unknown> | null = null;
		if (!user && this.getPasskeyOptions) {
			passkeyOptions = await this.getPasskeyOptions();
		}

		const passkeyAvailable = !user && !!passkeyOptions;

		// Show consent UI
		const scope = params.scope ?? "atproto";
		const html = renderConsentUI({
			client,
			scope,
			authorizeUrl: url.pathname,
			state: params.state!,
			oauthParams: params,
			userHandle: user?.handle,
			showLogin: !user && !!this.verifyUser,
			passkeyAvailable,
			passkeyOptions: passkeyOptions ?? undefined,
		});

		const csp = await getConsentUiCsp(passkeyAvailable);

		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": csp,
				"Cache-Control": "no-store",
			},
		});
	}

	/**
	 * Handle authorization form POST
	 */
	private async handleAuthorizePost(
		request: Request,
		params: Record<string, string>,
		client: ClientMetadata
	): Promise<Response> {
		// Form data was already parsed in handleAuthorize - extract action and password
		const action = params.action;
		const password = params.password ?? null;

		const redirectUri = params.redirect_uri!;
		const state = params.state!;
		// Default response_mode is "query" for authorization code flow per RFC 6749
		const responseMode = params.response_mode ?? "query";

		// Handle deny
		if (action === "deny") {
			const errorUrl = new URL(redirectUri);

			if (responseMode === "fragment") {
				const hashParams = new URLSearchParams();
				hashParams.set("error", "access_denied");
				hashParams.set("error_description", "User denied authorization");
				hashParams.set("state", state);
				hashParams.set("iss", this.issuer);
				errorUrl.hash = hashParams.toString();
			} else {
				errorUrl.searchParams.set("error", "access_denied");
				errorUrl.searchParams.set("error_description", "User denied authorization");
				errorUrl.searchParams.set("state", state);
				errorUrl.searchParams.set("iss", this.issuer);
			}

			return Response.redirect(errorUrl.toString(), 302);
		}

		// Get or verify user
		let user: { sub: string; handle: string } | null = null;

		if (this.getCurrentUser) {
			user = await this.getCurrentUser();
		}

		if (!user && password && this.verifyUser) {
			user = await this.verifyUser(password);
		}

		if (!user) {
			// Show login form with error
			const url = new URL(request.url);
			const scope = params.scope ?? "atproto";
			const html = renderConsentUI({
				client,
				scope,
				authorizeUrl: url.pathname,
				state,
				oauthParams: params,
				showLogin: true,
				error: "Invalid password",
			});
			const csp = await getConsentUiCsp(false);
			return new Response(html, {
				status: 401,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": csp,
					"Cache-Control": "no-store",
				},
			});
		}

		// Generate authorization code
		const code = generateAuthCode();
		const scope = params.scope ?? "atproto";

		const authCodeData: AuthCodeData = {
			clientId: params.client_id!,
			redirectUri,
			codeChallenge: params.code_challenge!,
			codeChallengeMethod: "S256",
			scope,
			sub: user.sub,
			expiresAt: Date.now() + AUTH_CODE_TTL,
		};

		await this.storage.saveAuthCode(code, authCodeData);

		// Redirect with code (using fragment mode if requested)
		const successUrl = new URL(redirectUri);

		if (responseMode === "fragment") {
			// Put params in hash fragment
			const hashParams = new URLSearchParams();
			hashParams.set("code", code);
			hashParams.set("state", state);
			hashParams.set("iss", this.issuer);
			successUrl.hash = hashParams.toString();
		} else {
			// Put params in query string
			successUrl.searchParams.set("code", code);
			successUrl.searchParams.set("state", state);
			successUrl.searchParams.set("iss", this.issuer);
		}

		return Response.redirect(successUrl.toString(), 302);
	}

	/**
	 * Handle token request (POST /oauth/token)
	 */
	async handleToken(request: Request): Promise<Response> {
		let params: Record<string, string>;
		try {
			params = await parseRequestBody(request);
		} catch (e) {
			return oauthError("invalid_request", e instanceof Error ? e.message : "Invalid request");
		}

		const grantType = params.grant_type;

		if (grantType === "authorization_code") {
			return this.handleAuthorizationCodeGrant(request, params);
		} else if (grantType === "refresh_token") {
			return this.handleRefreshTokenGrant(request, params);
		} else {
			return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
		}
	}

	/**
	 * Handle authorization code grant
	 */
	private async handleAuthorizationCodeGrant(
		request: Request,
		params: Record<string, string>
	): Promise<Response> {
		// Validate required parameters
		const required = ["code", "client_id", "redirect_uri", "code_verifier"];
		for (const param of required) {
			if (!params[param]) {
				return oauthError("invalid_request", `Missing required parameter: ${param}`);
			}
		}

		// Authenticate client (validates private_key_jwt for confidential clients)
		try {
			await authenticateClient(
				params,
				async (clientId) => {
					if (this.clientResolver) {
						try {
							return await this.clientResolver.resolveClient(clientId);
						} catch {
							return null;
						}
					}
					return this.storage.getClient(clientId);
				},
				{
					tokenEndpoint: `${this.issuer}/oauth/token`,
					issuer: this.issuer,
					checkJti: async (jti) => this.storage.checkAndSaveNonce(jti),
				}
			);
		} catch (e) {
			if (e instanceof ClientAuthError) {
				return oauthError(e.code, e.message);
			}
			return oauthError("invalid_client", "Client authentication failed");
		}

		// Get authorization code data
		const codeData = await this.storage.getAuthCode(params.code!);
		if (!codeData) {
			return oauthError("invalid_grant", "Invalid or expired authorization code");
		}

		// Delete code (one-time use)
		await this.storage.deleteAuthCode(params.code!);

		// Verify client_id matches
		if (codeData.clientId !== params.client_id) {
			return oauthError("invalid_grant", "client_id mismatch");
		}

		// Verify redirect_uri matches
		if (codeData.redirectUri !== params.redirect_uri) {
			return oauthError("invalid_grant", "redirect_uri mismatch");
		}

		// Verify PKCE
		const pkceValid = await verifyPkceChallenge(
			params.code_verifier!,
			codeData.codeChallenge,
			codeData.codeChallengeMethod
		);
		if (!pkceValid) {
			return oauthError("invalid_grant", "Invalid code_verifier");
		}

		// Verify DPoP if required
		let dpopJkt: string | undefined;
		if (this.dpopRequired) {
			try {
				const dpopProof = await verifyDpopProof(request);

				// Verify jti is unique (replay prevention)
				const nonceUnique = await this.storage.checkAndSaveNonce(dpopProof.jti);
				if (!nonceUnique) {
					return oauthError("invalid_dpop_proof", "DPoP proof replay detected");
				}

				dpopJkt = dpopProof.jkt;
			} catch (e) {
				if (e instanceof DpopError) {
					// Check if we need to send a nonce
					if (e.code === "use_dpop_nonce") {
						const nonce = generateDpopNonce();
						return new Response(
							JSON.stringify({
								error: "use_dpop_nonce",
								error_description: "DPoP nonce required",
							}),
							{
								status: 400,
								headers: {
									"Content-Type": "application/json",
									"DPoP-Nonce": nonce,
									"Cache-Control": "no-store",
								},
							}
						);
					}
					return oauthError("invalid_dpop_proof", e.message);
				}
				return oauthError("invalid_dpop_proof", "DPoP verification failed");
			}
		} else {
			// Check if DPoP header is present (optional but binding)
			const dpopHeader = request.headers.get("DPoP");
			if (dpopHeader) {
				try {
					const dpopProof = await verifyDpopProof(request);
					const nonceUnique = await this.storage.checkAndSaveNonce(dpopProof.jti);
					if (!nonceUnique) {
						return oauthError("invalid_dpop_proof", "DPoP proof replay detected");
					}
					dpopJkt = dpopProof.jkt;
				} catch (e) {
					if (e instanceof DpopError) {
						return oauthError("invalid_dpop_proof", e.message);
					}
					return oauthError("invalid_dpop_proof", "DPoP verification failed");
				}
			}
		}

		// Generate tokens
		const { tokens, tokenData } = generateTokens({
			sub: codeData.sub,
			clientId: codeData.clientId,
			scope: codeData.scope,
			dpopJkt,
		});

		// Save tokens
		await this.storage.saveTokens(tokenData);

		// Return token response
		return new Response(JSON.stringify(buildTokenResponse(tokens)), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}

	/**
	 * Handle refresh token grant
	 */
	private async handleRefreshTokenGrant(
		request: Request,
		params: Record<string, string>
	): Promise<Response> {
		const refreshToken = params.refresh_token;
		if (!refreshToken) {
			return oauthError("invalid_request", "Missing refresh_token parameter");
		}

		// Authenticate client if client_id is provided
		if (params.client_id) {
			try {
				await authenticateClient(
					params,
					async (clientId) => {
						if (this.clientResolver) {
							try {
								return await this.clientResolver.resolveClient(clientId);
							} catch {
								return null;
							}
						}
						return this.storage.getClient(clientId);
					},
					{
						tokenEndpoint: `${this.issuer}/oauth/token`,
						issuer: this.issuer,
						checkJti: async (jti) => this.storage.checkAndSaveNonce(jti),
					}
				);
			} catch (e) {
				if (e instanceof ClientAuthError) {
					return oauthError(e.code, e.message);
				}
				return oauthError("invalid_client", "Client authentication failed");
			}
		}

		// Get token data
		const existingData = await this.storage.getTokenByRefresh(refreshToken);
		if (!existingData) {
			return oauthError("invalid_grant", "Invalid refresh token");
		}

		// Check if token was revoked
		if (existingData.revoked) {
			return oauthError("invalid_grant", "Token has been revoked");
		}

		// Verify client_id if provided
		if (params.client_id && params.client_id !== existingData.clientId) {
			return oauthError("invalid_grant", "client_id mismatch");
		}

		// Verify DPoP if token was DPoP-bound
		if (existingData.dpopJkt) {
			try {
				const dpopProof = await verifyDpopProof(request);

				// Verify key thumbprint matches
				if (dpopProof.jkt !== existingData.dpopJkt) {
					return oauthError("invalid_dpop_proof", "DPoP key mismatch");
				}

				// Verify jti is unique
				const nonceUnique = await this.storage.checkAndSaveNonce(dpopProof.jti);
				if (!nonceUnique) {
					return oauthError("invalid_dpop_proof", "DPoP proof replay detected");
				}
			} catch (e) {
				if (e instanceof DpopError) {
					return oauthError("invalid_dpop_proof", e.message);
				}
				return oauthError("invalid_dpop_proof", "DPoP verification failed");
			}
		}

		// Revoke old tokens
		await this.storage.revokeToken(existingData.accessToken);

		// Generate new tokens (with refresh token rotation)
		const { tokens, tokenData } = refreshTokens(existingData, true);

		// Save new tokens
		await this.storage.saveTokens(tokenData);

		// Return token response
		return new Response(JSON.stringify(buildTokenResponse(tokens)), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}

	/**
	 * Handle PAR request (POST /oauth/par)
	 */
	async handlePAR(request: Request): Promise<Response> {
		if (!this.enablePAR) {
			return oauthError("invalid_request", "PAR is not enabled");
		}
		return this.parHandler.handlePushRequest(request);
	}

	/**
	 * Handle metadata request (GET /.well-known/oauth-authorization-server)
	 */
	handleMetadata(): Response {
		// URLs are built dynamically so we cast to the schema type
		const metadata: OAuthAuthorizationServerMetadata = {
			issuer: this.issuer,
			authorization_endpoint: `${this.issuer}/oauth/authorize`,
			token_endpoint: `${this.issuer}/oauth/token`,
			userinfo_endpoint: `${this.issuer}/oauth/userinfo`,
			response_types_supported: ["code"],
			response_modes_supported: ["fragment", "query"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			scopes_supported: ["atproto", "transition:generic", "transition:chat.bsky"],
			subject_types_supported: ["public"],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
			token_endpoint_auth_signing_alg_values_supported: ["ES256"],
			...(this.enablePAR && {
				pushed_authorization_request_endpoint: `${this.issuer}/oauth/par`,
				require_pushed_authorization_requests: true,
			}),
			...(this.dpopRequired && {
				dpop_signing_alg_values_supported: ["ES256"],
			}),
		} as OAuthAuthorizationServerMetadata;

		return new Response(JSON.stringify(metadata), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=3600",
			},
		});
	}

	/**
	 * Verify an access token from a request
	 * @param request The HTTP request
	 * @param requiredScope Optional scope to require
	 * @returns Token data if valid
	 */
	async verifyAccessToken(
		request: Request,
		requiredScope?: string
	): Promise<TokenData | null> {
		// Extract token from Authorization header
		const tokenInfo = extractAccessToken(request);
		if (!tokenInfo) {
			return null;
		}

		// Lookup token
		const tokenData = await this.storage.getTokenByAccess(tokenInfo.token);
		if (!tokenData) {
			return null;
		}

		// Check validity
		if (!isTokenValid(tokenData)) {
			return null;
		}

		// Check token type matches
		if (tokenData.dpopJkt && tokenInfo.type !== "DPoP") {
			return null; // DPoP-bound token must use DPoP header
		}

		// Verify DPoP if token is bound
		if (tokenData.dpopJkt) {
			try {
				const dpopProof = await verifyDpopProof(request, {
					accessToken: tokenInfo.token,
				});

				// Verify key thumbprint matches
				if (dpopProof.jkt !== tokenData.dpopJkt) {
					return null;
				}

				// Verify jti is unique
				const nonceUnique = await this.storage.checkAndSaveNonce(dpopProof.jti);
				if (!nonceUnique) {
					return null;
				}
			} catch {
				return null;
			}
		}

		// Check scope if required
		if (requiredScope) {
			const scopes = tokenData.scope.split(" ");
			if (!scopes.includes(requiredScope)) {
				return null;
			}
		}

		return tokenData;
	}

	/**
	 * Handle passkey authentication (POST /oauth/passkey-auth)
	 *
	 * This endpoint is called by the client-side JavaScript after a successful
	 * WebAuthn authentication. It verifies the passkey and returns a redirect URL
	 * to complete the OAuth authorization flow.
	 */
	async handlePasskeyAuth(request: Request): Promise<Response> {
		if (!this.verifyPasskey) {
			return oauthError("unsupported_auth_method", "Passkey authentication is not configured", 400);
		}

		let body: {
			response: PasskeyAuthResponse;
			challenge: string;
			oauthParams: Record<string, string>;
		};

		try {
			body = await request.json();
		} catch {
			return oauthError("invalid_request", "Invalid JSON body", 400);
		}

		const { response, challenge, oauthParams } = body;

		if (!response || !challenge || !oauthParams) {
			return oauthError("invalid_request", "Missing required parameters", 400);
		}

		// Verify the passkey
		const user = await this.verifyPasskey(response, challenge);
		if (!user) {
			return new Response(JSON.stringify({ error: "Authentication failed" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Validate OAuth params
		const required = ["client_id", "redirect_uri", "state", "code_challenge"];
		for (const param of required) {
			if (!oauthParams[param]) {
				return new Response(JSON.stringify({ error: `Missing OAuth parameter: ${param}` }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		// Generate authorization code
		const code = generateAuthCode();
		const scope = oauthParams.scope ?? "atproto";

		const authCodeData: AuthCodeData = {
			clientId: oauthParams.client_id!,
			redirectUri: oauthParams.redirect_uri!,
			codeChallenge: oauthParams.code_challenge!,
			codeChallengeMethod: "S256",
			scope,
			sub: user.sub,
			expiresAt: Date.now() + AUTH_CODE_TTL,
		};

		await this.storage.saveAuthCode(code, authCodeData);

		// Build redirect URL
		const responseMode = oauthParams.response_mode ?? "query";
		const redirectUrl = new URL(oauthParams.redirect_uri!);

		if (responseMode === "fragment") {
			const hashParams = new URLSearchParams();
			hashParams.set("code", code);
			hashParams.set("state", oauthParams.state!);
			hashParams.set("iss", this.issuer);
			redirectUrl.hash = hashParams.toString();
		} else {
			redirectUrl.searchParams.set("code", code);
			redirectUrl.searchParams.set("state", oauthParams.state!);
			redirectUrl.searchParams.set("iss", this.issuer);
		}

		return new Response(JSON.stringify({ redirectUrl: redirectUrl.toString() }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * Render an error page
	 */
	private async renderError(error: string, description: string): Promise<Response> {
		const html = renderErrorPage(error, description);
		const csp = await getConsentUiCsp(false);
		return new Response(html, {
			status: 400,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": csp,
				"Cache-Control": "no-store",
			},
		});
	}
}
