/**
 * Token generation and validation
 * Generates opaque tokens (not JWTs) that are stored in the database
 */

import type { OAuthTokenResponse } from "@atproto/oauth-types";
import type { TokenData } from "./storage.js";
import { randomString } from "./encoding.js";

/** Default access token TTL: 1 hour */
export const ACCESS_TOKEN_TTL = 60 * 60 * 1000;

/** Default refresh token TTL: 90 days */
export const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60 * 1000;

/** Authorization code TTL: 5 minutes */
export const AUTH_CODE_TTL = 5 * 60 * 1000;

/**
 * Generate a cryptographically random token
 * @param bytes Number of random bytes (default: 32)
 * @returns Base64URL-encoded token
 */
export function generateRandomToken(bytes: number = 32): string {
	return randomString(bytes);
}

/**
 * Generate an authorization code
 * @returns A random authorization code
 */
export function generateAuthCode(): string {
	return generateRandomToken(32);
}

/**
 * Token generation result
 */
export interface GeneratedTokens {
	/** Opaque access token */
	accessToken: string;
	/** Opaque refresh token */
	refreshToken: string;
	/** Access token type (Bearer or DPoP) */
	tokenType: "Bearer" | "DPoP";
	/** Access token expiration in seconds */
	expiresIn: number;
	/** Scope granted */
	scope: string;
	/** Subject (user DID) */
	sub: string;
}

/**
 * Options for token generation
 */
export interface GenerateTokensOptions {
	/** User DID */
	sub: string;
	/** Client DID */
	clientId: string;
	/** Scope granted */
	scope: string;
	/** DPoP key thumbprint (if using DPoP) */
	dpopJkt?: string;
	/** Custom access token TTL in ms (default: 1 hour) */
	accessTokenTtl?: number;
	/** Custom refresh token TTL in ms (default: 90 days) */
	refreshTokenTtl?: number;
}

/**
 * Generate access and refresh tokens
 * Tokens are opaque - their meaning comes from the database entry
 * @param options Token generation options
 * @returns Generated tokens and metadata
 */
export function generateTokens(options: GenerateTokensOptions): {
	tokens: GeneratedTokens;
	tokenData: TokenData;
} {
	const {
		sub,
		clientId,
		scope,
		dpopJkt,
		accessTokenTtl = ACCESS_TOKEN_TTL,
		refreshTokenTtl = REFRESH_TOKEN_TTL,
	} = options;

	const accessToken = generateRandomToken(32);
	const refreshToken = generateRandomToken(32);
	const now = Date.now();

	const tokenData: TokenData = {
		accessToken,
		refreshToken,
		clientId,
		sub,
		scope,
		dpopJkt,
		issuedAt: now,
		expiresAt: now + accessTokenTtl,
		revoked: false,
	};

	const tokens: GeneratedTokens = {
		accessToken,
		refreshToken,
		tokenType: dpopJkt ? "DPoP" : "Bearer",
		expiresIn: Math.floor(accessTokenTtl / 1000),
		scope,
		sub,
	};

	return { tokens, tokenData };
}

/**
 * Refresh tokens - generates new access token, optionally rotates refresh token
 * @param existingData The existing token data
 * @param rotateRefreshToken Whether to generate a new refresh token
 * @param accessTokenTtl Custom access token TTL in ms
 * @returns Updated tokens and token data
 */
export function refreshTokens(
	existingData: TokenData,
	rotateRefreshToken: boolean = false,
	accessTokenTtl: number = ACCESS_TOKEN_TTL
): {
	tokens: GeneratedTokens;
	tokenData: TokenData;
} {
	const accessToken = generateRandomToken(32);
	const refreshToken = rotateRefreshToken ? generateRandomToken(32) : existingData.refreshToken;
	const now = Date.now();

	const tokenData: TokenData = {
		...existingData,
		accessToken,
		refreshToken,
		issuedAt: now,
		expiresAt: now + accessTokenTtl,
	};

	const tokens: GeneratedTokens = {
		accessToken,
		refreshToken,
		tokenType: existingData.dpopJkt ? "DPoP" : "Bearer",
		expiresIn: Math.floor(accessTokenTtl / 1000),
		scope: existingData.scope,
		sub: existingData.sub,
	};

	return { tokens, tokenData };
}

/**
 * Build token response for OAuth token endpoint
 * @param tokens The generated tokens
 * @returns JSON-serializable token response
 */
export function buildTokenResponse(tokens: GeneratedTokens): OAuthTokenResponse {
	return {
		access_token: tokens.accessToken,
		token_type: tokens.tokenType,
		expires_in: tokens.expiresIn,
		refresh_token: tokens.refreshToken,
		scope: tokens.scope,
		sub: tokens.sub,
	};
}

/**
 * Extract access token from Authorization header
 * Supports both Bearer and DPoP token types
 * @param request The HTTP request
 * @returns The access token and type, or null if not found
 */
export function extractAccessToken(
	request: Request
): { token: string; type: "Bearer" | "DPoP" } | null {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader) {
		return null;
	}

	if (authHeader.startsWith("Bearer ")) {
		return {
			token: authHeader.slice(7),
			type: "Bearer",
		};
	}

	if (authHeader.startsWith("DPoP ")) {
		return {
			token: authHeader.slice(5),
			type: "DPoP",
		};
	}

	return null;
}

/**
 * Validate that a token is not expired or revoked
 * @param tokenData The token data from storage
 * @returns true if the token is valid
 */
export function isTokenValid(tokenData: TokenData): boolean {
	if (tokenData.revoked) {
		return false;
	}
	if (Date.now() > tokenData.expiresAt) {
		return false;
	}
	return true;
}
