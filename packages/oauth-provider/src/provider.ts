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
import { renderConsentUI, renderErrorPage, CONSENT_UI_CSP } from "./ui.js";

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

	constructor(config: OAuthProviderConfig) {
		this.storage = config.storage;
		this.issuer = config.issuer;
		this.dpopRequired = config.dpopRequired ?? true;
		this.enablePAR = config.enablePAR ?? true;
		this.parHandler = new PARHandler(config.storage, config.issuer);
		this.clientResolver = config.clientResolver ?? new ClientResolver({ storage: config.storage });
		this.verifyUser = config.verifyUser;
		this.getCurrentUser = config.getCurrentUser;
	}

	/**
	 * Handle authorization request (GET /oauth/authorize)
	 */
	async handleAuthorize(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Check if this is a PAR request
		let params: Record<string, string>;
		const requestUri = url.searchParams.get("request_uri");
		const clientId = url.searchParams.get("client_id");

		if (requestUri && this.enablePAR) {
			if (!clientId) {
				return this.renderError("invalid_request", "client_id required with request_uri");
			}
			const parParams = await this.parHandler.retrieveParams(requestUri, clientId);
			if (!parParams) {
				return this.renderError("invalid_request", "Invalid or expired request_uri");
			}
			params = parParams;
		} else {
			// Parse query parameters
			params = Object.fromEntries(url.searchParams.entries());
		}

		// Validate required parameters
		const required = ["client_id", "redirect_uri", "response_type", "code_challenge", "state"];
		for (const param of required) {
			if (!params[param]) {
				return this.renderError("invalid_request", `Missing required parameter: ${param}`);
			}
		}

		// Validate response_type
		if (params.response_type !== "code") {
			return this.renderError("unsupported_response_type", "Only response_type=code is supported");
		}

		// Validate code_challenge_method
		if (params.code_challenge_method && params.code_challenge_method !== "S256") {
			return this.renderError("invalid_request", "Only code_challenge_method=S256 is supported");
		}

		// Resolve client metadata
		let client: ClientMetadata;
		try {
			client = await this.clientResolver.resolveClient(params.client_id!);
		} catch (e) {
			return this.renderError("invalid_client", `Failed to resolve client: ${e}`);
		}

		// Validate redirect_uri
		if (!client.redirectUris.includes(params.redirect_uri!)) {
			return this.renderError("invalid_request", "Invalid redirect_uri for this client");
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

		// Show consent UI
		const scope = params.scope ?? "atproto";
		const html = renderConsentUI({
			client,
			scope,
			authorizeUrl: url.pathname,
			state: params.state!,
			userHandle: user?.handle,
			showLogin: !user && !!this.verifyUser,
		});

		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": CONSENT_UI_CSP,
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
		// Parse form data
		const formData = await request.formData();
		const action = formData.get("action") as string;
		const password = formData.get("password") as string | null;

		const redirectUri = params.redirect_uri!;
		const state = params.state!;

		// Handle deny
		if (action === "deny") {
			const errorUrl = new URL(redirectUri);
			errorUrl.searchParams.set("error", "access_denied");
			errorUrl.searchParams.set("error_description", "User denied authorization");
			errorUrl.searchParams.set("state", state);
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
				showLogin: true,
				error: "Invalid password",
			});
			return new Response(html, {
				status: 401,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": CONSENT_UI_CSP,
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

		// Redirect with code
		const successUrl = new URL(redirectUri);
		successUrl.searchParams.set("code", code);
		successUrl.searchParams.set("state", state);
		return Response.redirect(successUrl.toString(), 302);
	}

	/**
	 * Handle token request (POST /oauth/token)
	 */
	async handleToken(request: Request): Promise<Response> {
		// Validate content type
		const contentType = request.headers.get("Content-Type");
		if (!contentType?.includes("application/x-www-form-urlencoded")) {
			return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded");
		}

		// Parse form body
		const body = await request.text();
		const params = Object.fromEntries(new URLSearchParams(body).entries());

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
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["atproto", "transition:generic", "transition:chat.bsky"],
			subject_types_supported: ["public"],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
			...(this.enablePAR && {
				pushed_authorization_request_endpoint: `${this.issuer}/oauth/par`,
				require_pushed_authorization_requests: false,
			}),
			...(this.dpopRequired && {
				dpop_signing_alg_values_supported: ["ES256"],
				token_endpoint_auth_signing_alg_values_supported: ["ES256"],
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
	 * Render an error page
	 */
	private renderError(error: string, description: string): Response {
		const html = renderErrorPage(error, description);
		return new Response(html, {
			status: 400,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": CONSENT_UI_CSP,
				"Cache-Control": "no-store",
			},
		});
	}
}
