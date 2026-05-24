import { describe, it, expect, beforeEach } from "vitest";
import { ClientResolver } from "../src/client-resolver.js";
import { PARHandler } from "../src/par.js";
import type {
	LexiconPermissionSet,
	PermissionSetResolver,
} from "../src/permission-sets.js";
import { InMemoryOAuthStorage } from "../src/storage.js";
import type { ClientMetadata } from "../src/storage.js";
import { generateCodeChallenge, generateCodeVerifier } from "./helpers.js";

/**
 * Stub resolver for PAR tests: returns metadata with a fixed registered
 * redirect_uri so PAR's RFC 6749 §3.1.2.4 check passes for the canonical
 * fixture. Tests that probe rejection pass a different redirect_uri.
 */
class StubResolver extends ClientResolver {
	private fixed: ClientMetadata;
	constructor(redirectUri: string) {
		super();
		this.fixed = {
			clientId: "did:web:client.example.com",
			clientName: "Test Client",
			redirectUris: [redirectUri],
			tokenEndpointAuthMethod: "none",
			cachedAt: Date.now(),
		};
	}
	override async resolveClient(): Promise<ClientMetadata> {
		return this.fixed;
	}
}

describe("PAR Handler", () => {
	let storage: InMemoryOAuthStorage;
	let handler: PARHandler;
	const REGISTERED_REDIRECT = "https://client.example.com/callback";

	beforeEach(() => {
		storage = new InMemoryOAuthStorage();
		handler = new PARHandler(
			storage,
			new StubResolver(REGISTERED_REDIRECT),
			"https://example.com",
		);
	});

	function createPARRequest(params: Record<string, string>): Request {
		const body = new URLSearchParams(params).toString();
		return new Request("https://example.com/oauth/par", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		});
	}

	describe("handlePushRequest", () => {
		it("accepts valid PAR request", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
				scope: "atproto",
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(201);

			const json = await response.json();
			expect(json).toHaveProperty("request_uri");
			expect(json.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
			expect(json).toHaveProperty("expires_in", 300);
		});

		it("rejects request with wrong content type", async () => {
			const request = new Request("https://example.com/oauth/par", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_request");
		});

		it("rejects request missing client_id", async () => {
			const request = createPARRequest({
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
				code_challenge_method: "S256",
				state: "random-state",
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_request");
		});

		it("rejects redirect_uri not registered in client metadata (RFC 6749 §3.1.2.4)", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: "https://attacker.invalid/steal-code",
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
				scope: "atproto",
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as {
				error: string;
				error_description: string;
			};
			expect(json.error).toBe("invalid_request");
			expect(json.error_description).toMatch(/not registered/i);
		});

		it("rejects include: for a permission set that fails to resolve", async () => {
			const resolver: PermissionSetResolver = {
				async resolve() {
					return null;
				},
			};
			const handlerWithResolver = new PARHandler(
				storage,
				new StubResolver(REGISTERED_REDIRECT),
				"https://example.com",
				undefined,
				resolver,
			);

			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: REGISTERED_REDIRECT,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
				scope: "atproto include:com.example.nonexistent",
			});

			const response = await handlerWithResolver.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as {
				error: string;
				error_description: string;
			};
			expect(json.error).toBe("invalid_scope");
			expect(json.error_description).toMatch(/com\.example\.nonexistent/);
		});

		it("accepts include: that the resolver successfully resolves", async () => {
			const permissionSet: LexiconPermissionSet = {
				type: "permission-set",
				title: "Test bundle",
				detail: "for tests",
				permissions: [],
			};
			const resolver: PermissionSetResolver = {
				async resolve() {
					return permissionSet;
				},
			};
			const handlerWithResolver = new PARHandler(
				storage,
				new StubResolver(REGISTERED_REDIRECT),
				"https://example.com",
				undefined,
				resolver,
			);

			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: REGISTERED_REDIRECT,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
				scope: "atproto include:com.example.real",
			});

			const response = await handlerWithResolver.handlePushRequest(request);
			expect(response.status).toBe(201);
			const json = (await response.json()) as { request_uri: string };
			expect(json.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
		});

		it("rejects unsupported response_type", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: "https://client.example.com/callback",
				response_type: "token",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("unsupported_response_type");
		});

		it("rejects non-S256 code_challenge_method", async () => {
			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: "some-challenge",
				code_challenge_method: "plain",
				state: "random-state",
			});

			const response = await handler.handlePushRequest(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_request");
		});
	});

	describe("retrieveParams", () => {
		it("retrieves valid PAR params", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const clientId = "did:web:client.example.com";

			const request = createPARRequest({
				client_id: clientId,
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
				scope: "atproto",
			});

			const pushResponse = await handler.handlePushRequest(request);
			const pushJson = (await pushResponse.json()) as { request_uri: string };

			const params = await handler.retrieveParams(
				pushJson.request_uri,
				clientId,
			);
			expect(params).not.toBeNull();
			expect(params!.client_id).toBe(clientId);
			expect(params!.code_challenge).toBe(challenge);
		});

		it("returns null for non-existent request_uri", async () => {
			const params = await handler.retrieveParams(
				"urn:ietf:params:oauth:request_uri:nonexistent",
				"did:web:client.example.com",
			);
			expect(params).toBeNull();
		});

		it("returns null for mismatched client_id", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const request = createPARRequest({
				client_id: "did:web:client.example.com",
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
			});

			const pushResponse = await handler.handlePushRequest(request);
			const pushJson = (await pushResponse.json()) as { request_uri: string };

			const params = await handler.retrieveParams(
				pushJson.request_uri,
				"did:web:other.example.com",
			);
			expect(params).toBeNull();
		});

		it("deletes params after retrieval (one-time use)", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const clientId = "did:web:client.example.com";

			const request = createPARRequest({
				client_id: clientId,
				redirect_uri: "https://client.example.com/callback",
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "random-state",
			});

			const pushResponse = await handler.handlePushRequest(request);
			const pushJson = (await pushResponse.json()) as { request_uri: string };

			// First retrieval should work
			const params1 = await handler.retrieveParams(
				pushJson.request_uri,
				clientId,
			);
			expect(params1).not.toBeNull();

			// Second retrieval should return null
			const params2 = await handler.retrieveParams(
				pushJson.request_uri,
				clientId,
			);
			expect(params2).toBeNull();
		});
	});

	describe("isRequestUri", () => {
		it("returns true for valid request_uri format", () => {
			expect(
				PARHandler.isRequestUri("urn:ietf:params:oauth:request_uri:abc123"),
			).toBe(true);
		});

		it("returns false for invalid format", () => {
			expect(PARHandler.isRequestUri("https://example.com")).toBe(false);
			expect(PARHandler.isRequestUri("invalid")).toBe(false);
		});
	});
});
