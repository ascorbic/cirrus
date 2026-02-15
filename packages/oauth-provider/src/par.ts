/**
 * PAR (Pushed Authorization Requests) handler
 * Implements RFC 9126
 */

import type { OAuthParResponse } from "@atproto/oauth-types";
import type { OAuthStorage, PARData } from "./storage.js";
import { randomString } from "./encoding.js";
import { parseRequestBody } from "./provider.js";

export type { OAuthParResponse };

/** PAR request URI prefix per RFC 9126 */
const REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

/** Default PAR expiration in seconds (90 seconds per RFC recommendation) */
const DEFAULT_EXPIRES_IN = 90;

/**
 * OAuth error response
 */
export interface OAuthErrorResponse {
	error: string;
	error_description?: string;
}

/**
 * Generate a unique request URI
 */
function generateRequestUri(): string {
	return REQUEST_URI_PREFIX + randomString(32);
}

/**
 * Required OAuth parameters for authorization request
 */
const REQUIRED_PARAMS = [
	"client_id",
	"redirect_uri",
	"response_type",
	"code_challenge",
	"code_challenge_method",
	"state",
];

/**
 * Handler for Pushed Authorization Requests (PAR)
 */
export class PARHandler {
	private storage: OAuthStorage;
	private issuer: string;
	private expiresIn: number;

	/**
	 * Create a PAR handler
	 * @param storage OAuth storage implementation
	 * @param issuer The OAuth issuer URL
	 * @param expiresIn PAR expiration time in seconds (default: 90)
	 */
	constructor(
		storage: OAuthStorage,
		issuer: string,
		expiresIn: number = DEFAULT_EXPIRES_IN,
	) {
		this.storage = storage;
		this.issuer = issuer;
		this.expiresIn = expiresIn;
	}

	/**
	 * Handle a PAR push request
	 * POST /oauth/par
	 * @param request The HTTP request
	 * @returns Response with request_uri or error
	 */
	async handlePushRequest(request: Request): Promise<Response> {
		let params: Record<string, string>;
		try {
			params = await parseRequestBody(request);
		} catch (e) {
			return this.errorResponse(
				"invalid_request",
				e instanceof Error ? e.message : "Invalid request",
				400,
			);
		}

		const clientId = params.client_id;
		if (!clientId) {
			return this.errorResponse(
				"invalid_request",
				"Missing client_id parameter",
				400,
			);
		}

		for (const param of REQUIRED_PARAMS) {
			if (!params[param]) {
				return this.errorResponse(
					"invalid_request",
					`Missing required parameter: ${param}`,
					400,
				);
			}
		}

		if (params.response_type !== "code") {
			return this.errorResponse(
				"unsupported_response_type",
				"Only response_type=code is supported",
				400,
			);
		}

		if (params.code_challenge_method !== "S256") {
			return this.errorResponse(
				"invalid_request",
				"Only code_challenge_method=S256 is supported",
				400,
			);
		}

		const codeChallenge = params.code_challenge!;
		if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
			return this.errorResponse(
				"invalid_request",
				"Invalid code_challenge format",
				400,
			);
		}

		try {
			new URL(params.redirect_uri!);
		} catch {
			return this.errorResponse("invalid_request", "Invalid redirect_uri", 400);
		}

		const requestUri = generateRequestUri();
		const expiresAt = Date.now() + this.expiresIn * 1000;

		const parData: PARData = {
			clientId,
			params,
			expiresAt,
		};

		await this.storage.savePAR(requestUri, parData);

		const response: OAuthParResponse = {
			request_uri: requestUri,
			expires_in: this.expiresIn,
		};

		return new Response(JSON.stringify(response), {
			status: 201,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}

	/**
	 * Retrieve and consume PAR parameters
	 * Called during authorization request handling
	 * @param requestUri The request URI from the authorization request
	 * @param clientId The client_id from the authorization request (for verification)
	 * @returns The stored parameters or null if not found/expired
	 */
	async retrieveParams(
		requestUri: string,
		clientId: string,
	): Promise<Record<string, string> | null> {
		if (!requestUri.startsWith(REQUEST_URI_PREFIX)) {
			return null;
		}

		const parData = await this.storage.getPAR(requestUri);
		if (!parData) {
			return null;
		}

		if (parData.clientId !== clientId) {
			return null;
		}

		// One-time use: delete after retrieval
		await this.storage.deletePAR(requestUri);

		return parData.params;
	}

	/**
	 * Check if a request_uri is valid format
	 */
	static isRequestUri(value: string): boolean {
		return value.startsWith(REQUEST_URI_PREFIX);
	}

	/**
	 * Create an OAuth error response
	 */
	private errorResponse(
		error: string,
		description: string,
		status: number = 400,
	): Response {
		const body: OAuthErrorResponse = {
			error,
			error_description: description,
		};
		return new Response(JSON.stringify(body), {
			status,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}
}
