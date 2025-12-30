/**
 * @ascorbic/atproto-oauth-provider
 * OAuth 2.1 Provider with AT Protocol extensions for Cloudflare Workers
 */

// Core provider
export { ATProtoOAuthProvider, parseRequestBody, RequestBodyError } from "./provider.js";
export type { OAuthProviderConfig } from "./provider.js";

// Storage interface and types
export { InMemoryOAuthStorage } from "./storage.js";
export type {
	OAuthStorage,
	AuthCodeData,
	TokenData,
	ClientMetadata,
	PARData,
} from "./storage.js";

// PKCE
export { verifyPkceChallenge } from "./pkce.js";

// DPoP
export { verifyDpopProof, generateDpopNonce, DpopError } from "./dpop.js";
export type { DpopProof, DpopVerifyOptions } from "./dpop.js";

// PAR
export { PARHandler } from "./par.js";
export type { OAuthParResponse, OAuthErrorResponse } from "./par.js";

// Client resolution
export { ClientResolver, createClientResolver, ClientResolutionError } from "./client-resolver.js";
export type { ClientResolverOptions, OAuthClientMetadata } from "./client-resolver.js";

// Tokens
export {
	generateAuthCode,
	generateTokens,
	refreshTokens,
	buildTokenResponse,
	extractAccessToken,
	isTokenValid,
	generateRandomToken,
	ACCESS_TOKEN_TTL,
	REFRESH_TOKEN_TTL,
	AUTH_CODE_TTL,
} from "./tokens.js";
export type { GeneratedTokens, GenerateTokensOptions } from "./tokens.js";

// UI
export { renderConsentUI, renderErrorPage, CONSENT_UI_CSP } from "./ui.js";
export type { ConsentUIOptions } from "./ui.js";
