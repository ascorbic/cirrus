import { describe, it, expect, beforeEach } from "vitest";
import { ATProtoOAuthProvider } from "../src/provider.js";
import { InMemoryOAuthStorage, type ClientMetadata } from "../src/storage.js";
import { ClientResolver } from "../src/client-resolver.js";
import {
	generateCodeChallenge,
	generateCodeVerifier,
	createDpopProof,
	generateDpopKeyPair,
} from "./helpers.js";

// Mock client resolver that returns test metadata
class MockClientResolver extends ClientResolver {
	private clients = new Map<string, ClientMetadata>();

	registerClient(metadata: ClientMetadata) {
		this.clients.set(metadata.clientId, metadata);
	}

	async resolveClient(clientId: string): Promise<ClientMetadata> {
		const client = this.clients.get(clientId);
		if (!client) {
			throw new Error(`Client not found: ${clientId}`);
		}
		return client;
	}
}

/**
 * Push a PAR request and return the resulting request_uri. Tests that POST
 * directly to /oauth/authorize need to thread this through as a hidden form
 * field; with `enablePAR: true` the provider rejects POSTs without a valid
 * PAR record (defense against form-tampering / cross-origin form attacks).
 */
async function pushPAR(
	provider: ATProtoOAuthProvider,
	params: Record<string, string>,
): Promise<string> {
	const body = new URLSearchParams(params);
	const response = await provider.handlePAR(
		new Request("https://pds.example.com/oauth/par", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		}),
	);
	const data = (await response.json()) as { request_uri: string };
	return data.request_uri;
}

describe("OAuth Flow", () => {
	let storage: InMemoryOAuthStorage;
	let clientResolver: MockClientResolver;
	let provider: ATProtoOAuthProvider;

	const testUser = {
		sub: "did:web:user.example.com",
		handle: "user.example.com",
	};

	const testClient: ClientMetadata = {
		clientId: "did:web:client.example.com",
		clientName: "Test Client",
		redirectUris: ["https://client.example.com/callback"],
		logoUri: "https://client.example.com/logo.png",
	};

	beforeEach(() => {
		storage = new InMemoryOAuthStorage();
		clientResolver = new MockClientResolver({});
		clientResolver.registerClient(testClient);

		provider = new ATProtoOAuthProvider({
			storage,
			issuer: "https://pds.example.com",
			dpopRequired: true,
			enablePAR: true,
			clientResolver,
			getCurrentUser: async () => testUser,
		});
	});

	describe("Authorization Endpoint", () => {
		it("returns consent UI for GET request via PAR", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			// First, submit a PAR request
			const parBody = new URLSearchParams({
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const parRequest = new Request("https://pds.example.com/oauth/par", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: parBody.toString(),
			});
			const parResponse = await provider.handlePAR(parRequest);
			expect(parResponse.status).toBe(201);
			const parData = await parResponse.json();
			expect(parData.request_uri).toBeDefined();

			// Then use the request_uri to call the authorization endpoint
			const url = new URL("https://pds.example.com/oauth/authorize");
			url.searchParams.set("client_id", testClient.clientId);
			url.searchParams.set("request_uri", parData.request_uri);

			const request = new Request(url.toString(), { method: "GET" });
			const response = await provider.handleAuthorize(request);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toContain("text/html");

			const html = await response.text();
			expect(html).toContain(testClient.clientName);
		});

		it("rejects direct authorization requests when PAR is required", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const url = new URL("https://pds.example.com/oauth/authorize");
			url.searchParams.set("client_id", testClient.clientId);
			url.searchParams.set("redirect_uri", testClient.redirectUris[0]!);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("code_challenge", challenge);
			url.searchParams.set("code_challenge_method", "S256");
			url.searchParams.set("state", "test-state");

			const request = new Request(url.toString(), { method: "GET" });
			const response = await provider.handleAuthorize(request);

			expect(response.status).toBe(400);
			const html = await response.text();
			expect(html).toContain("Pushed Authorization Request required");
		});

		it("redirects with code after consent approval", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "allow");

			const response = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);

			expect(response.status).toBe(302);
			const location = response.headers.get("Location");
			expect(location).toBeDefined();

			const redirectUrl = new URL(location!);
			expect(redirectUrl.searchParams.has("code")).toBe(true);
			expect(redirectUrl.searchParams.get("state")).toBe("test-state");
			expect(redirectUrl.searchParams.get("iss")).toBe(
				"https://pds.example.com",
			);
		});

		it("redirects with error after consent denial", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "deny");

			const response = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);

			expect(response.status).toBe(302);
			const location = response.headers.get("Location");
			const redirectUrl = new URL(location!);
			expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
		});
	});

	describe("Token Endpoint", () => {
		async function getAuthCode(
			verifier: string,
		): Promise<{ code: string; challenge: string }> {
			const challenge = await generateCodeChallenge(verifier);

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "allow");

			const response = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			const location = response.headers.get("Location")!;
			const redirectUrl = new URL(location);
			const code = redirectUrl.searchParams.get("code")!;

			return { code, challenge };
		}

		it("exchanges authorization code for tokens with DPoP", async () => {
			const verifier = generateCodeVerifier();
			const { code } = await getAuthCode(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const dpopProof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: verifier,
			}).toString();

			const request = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof,
				},
				body,
			});

			const response = await provider.handleToken(request);
			expect(response.status).toBe(200);

			const json = (await response.json()) as {
				access_token: string;
				refresh_token: string;
				token_type: string;
				expires_in: number;
			};
			expect(json.access_token).toBeDefined();
			expect(json.refresh_token).toBeDefined();
			expect(json.token_type).toBe("DPoP");
			expect(json.expires_in).toBeGreaterThan(0);
		});

		it("rejects invalid PKCE verifier", async () => {
			const verifier = generateCodeVerifier();
			const { code } = await getAuthCode(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const dpopProof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: "wrong-verifier-value-that-is-long-enough",
			}).toString();

			const request = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof,
				},
				body,
			});

			const response = await provider.handleToken(request);
			expect(response.status).toBe(400);

			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_grant");
		});

		it("rejects code reuse", async () => {
			const verifier = generateCodeVerifier();
			const { code } = await getAuthCode(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			// First request succeeds
			const dpopProof1 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: verifier,
			}).toString();

			const request1 = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof1,
				},
				body,
			});

			const response1 = await provider.handleToken(request1);
			expect(response1.status).toBe(200);

			// Second request fails
			const dpopProof2 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const request2 = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof2,
				},
				body,
			});

			const response2 = await provider.handleToken(request2);
			expect(response2.status).toBe(400);
		});

		it("refreshes tokens with DPoP", async () => {
			const verifier = generateCodeVerifier();
			const { code } = await getAuthCode(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			// Get initial tokens
			const dpopProof1 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const body1 = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: verifier,
			}).toString();

			const request1 = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof1,
				},
				body: body1,
			});

			const response1 = await provider.handleToken(request1);
			const json1 = (await response1.json()) as { refresh_token: string };

			// Refresh tokens
			const dpopProof2 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const body2 = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: json1.refresh_token,
			}).toString();

			const request2 = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof2,
				},
				body: body2,
			});

			const response2 = await provider.handleToken(request2);
			expect(response2.status).toBe(200);

			const json2 = (await response2.json()) as {
				access_token: string;
				refresh_token: string;
			};
			expect(json2.access_token).toBeDefined();
			expect(json2.refresh_token).toBeDefined();
			// Refresh token should be rotated
			expect(json2.refresh_token).not.toBe(json1.refresh_token);
		});
	});

	describe("Metadata Endpoint", () => {
		it("returns OAuth authorization server metadata", async () => {
			const response = provider.handleMetadata();
			expect(response.status).toBe(200);

			const json = (await response.json()) as Record<string, unknown>;
			expect(json.issuer).toBe("https://pds.example.com");
			expect(json.authorization_endpoint).toBe(
				"https://pds.example.com/oauth/authorize",
			);
			expect(json.token_endpoint).toBe("https://pds.example.com/oauth/token");
			expect(json.pushed_authorization_request_endpoint).toBe(
				"https://pds.example.com/oauth/par",
			);
			expect(json.response_types_supported).toContain("code");
			expect(json.code_challenge_methods_supported).toContain("S256");
			expect(json.dpop_signing_alg_values_supported).toContain("ES256");
		});
	});

	describe("Token Verification", () => {
		it("verifies valid DPoP-bound access token", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "allow");

			const authResponse = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			const location = authResponse.headers.get("Location")!;
			const code = new URL(location).searchParams.get("code")!;

			const dpopProof1 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const tokenBody = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: verifier,
			}).toString();

			const tokenRequest = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof1,
				},
				body: tokenBody,
			});

			const tokenResponse = await provider.handleToken(tokenRequest);
			const tokens = (await tokenResponse.json()) as { access_token: string };

			// Compute access token hash for DPoP proof
			const tokenHash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(tokens.access_token),
			);
			const ath = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			// Verify token on API request
			const dpopProof2 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "GET", htu: "https://pds.example.com/api/resource", ath },
				"ES256",
			);

			const apiRequest = new Request("https://pds.example.com/api/resource", {
				method: "GET",
				headers: {
					Authorization: `DPoP ${tokens.access_token}`,
					DPoP: dpopProof2,
				},
			});

			const tokenData = await provider.verifyAccessToken(apiRequest);
			expect(tokenData).not.toBeNull();
			expect(tokenData!.sub).toBe(testUser.sub);
			expect(tokenData!.clientId).toBe(testClient.clientId);
		});

		it("rejects token with wrong DPoP key", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair1 = await generateDpopKeyPair("ES256");

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "allow");

			const authResponse = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			const location = authResponse.headers.get("Location")!;
			const code = new URL(location).searchParams.get("code")!;

			const dpopProof1 = await createDpopProof(
				keyPair1.privateKey,
				keyPair1.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const tokenBody = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				code_verifier: verifier,
			}).toString();

			const tokenRequest = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof1,
				},
				body: tokenBody,
			});

			const tokenResponse = await provider.handleToken(tokenRequest);
			const tokens = (await tokenResponse.json()) as { access_token: string };

			// Try to use token with a DIFFERENT key
			const keyPair2 = await generateDpopKeyPair("ES256");

			const tokenHash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(tokens.access_token),
			);
			const ath = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const dpopProof2 = await createDpopProof(
				keyPair2.privateKey,
				keyPair2.publicJwk,
				{ htm: "GET", htu: "https://pds.example.com/api/resource", ath },
				"ES256",
			);

			const apiRequest = new Request("https://pds.example.com/api/resource", {
				method: "GET",
				headers: {
					Authorization: `DPoP ${tokens.access_token}`,
					DPoP: dpopProof2,
				},
			});

			const tokenData = await provider.verifyAccessToken(apiRequest);
			expect(tokenData).toBeNull();
		});
	});

	describe("Granular Scopes", () => {
		async function authorizeAndToken(
			scope: string,
		): Promise<{ accessToken: string; keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>> }> {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const requestUri = await pushPAR(provider, {
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
				scope,
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("request_uri", requestUri);
			formData.set("action", "allow");

			const authResponse = await provider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			const location = authResponse.headers.get("Location")!;
			const code = new URL(location).searchParams.get("code")!;

			const dpopProof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);

			const tokenRequest = new Request("https://pds.example.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					DPoP: dpopProof,
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					client_id: testClient.clientId,
					redirect_uri: testClient.redirectUris[0]!,
					code_verifier: verifier,
				}).toString(),
			});

			const tokenResponse = await provider.handleToken(tokenRequest);
			const tokens = (await tokenResponse.json()) as { access_token: string };
			return { accessToken: tokens.access_token, keyPair };
		}

		async function apiRequestFor(
			accessToken: string,
			keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>>,
		): Promise<Request> {
			const tokenHash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(accessToken),
			);
			const ath = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			const proof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "GET", htu: "https://pds.example.com/api/resource", ath },
				"ES256",
			);
			return new Request("https://pds.example.com/api/resource", {
				method: "GET",
				headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof },
			});
		}

		it("issues a token carrying a granular repo scope", async () => {
			const { accessToken, keyPair } = await authorizeAndToken(
				"atproto repo:app.bsky.feed.post",
			);
			const data = await provider.verifyAccessToken(
				await apiRequestFor(accessToken, keyPair),
			);
			expect(data?.scope).toBe("atproto repo:app.bsky.feed.post");
		});

		it("verifyAccessToken passes when callback is satisfied", async () => {
			const { accessToken, keyPair } = await authorizeAndToken(
				"atproto repo:app.bsky.feed.post",
			);
			const data = await provider.verifyAccessToken(
				await apiRequestFor(accessToken, keyPair),
				(perms) =>
					perms.assertRepo({
						collection: "app.bsky.feed.post",
						action: "create",
					}),
			);
			expect(data).not.toBeNull();
		});

		it("verifyAccessToken returns null when callback throws ScopeMissingError", async () => {
			const { accessToken, keyPair } = await authorizeAndToken(
				"atproto repo:app.bsky.feed.post",
			);
			const data = await provider.verifyAccessToken(
				await apiRequestFor(accessToken, keyPair),
				(perms) =>
					perms.assertRepo({
						collection: "app.bsky.feed.like",
						action: "create",
					}),
			);
			expect(data).toBeNull();
		});

		it("transition:generic still satisfies a granular check", async () => {
			const { accessToken, keyPair } = await authorizeAndToken(
				"atproto transition:generic",
			);
			const data = await provider.verifyAccessToken(
				await apiRequestFor(accessToken, keyPair),
				(perms) =>
					perms.assertRepo({
						collection: "app.bsky.feed.post",
						action: "create",
					}),
			);
			expect(data).not.toBeNull();
		});

		it("rejects a PAR with include: scope when no resolver is configured", async () => {
			// PAR rejection happens upfront — without a resolver, the PAR
			// handler refuses to push at all rather than letting the user
			// dead-end at consent.
			const challenge = await generateCodeChallenge(generateCodeVerifier());
			const parBody = new URLSearchParams({
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
				scope:
					"atproto include:com.example.basic?aud=did:web:foo%23svc",
			});
			const response = await provider.handlePAR(
				new Request("https://pds.example.com/oauth/par", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: parBody.toString(),
				}),
			);
			expect(response.status).toBe(400);
			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_scope");
		});

		it("expands include: scopes inline when a resolver is configured", async () => {
			// Stand up a fresh provider with a mock permission-set resolver.
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const mockSet = {
				type: "permission-set" as const,
				permissions: [
					{
						type: "permission" as const,
						resource: "repo",
						collection: ["com.example.post"],
					},
				],
			};
			const localStorage = new InMemoryOAuthStorage();
			const localResolver = new MockClientResolver({});
			localResolver.registerClient(testClient);
			const localProvider = new ATProtoOAuthProvider({
				storage: localStorage,
				issuer: "https://pds.example.com",
				dpopRequired: true,
				enablePAR: false,
				clientResolver: localResolver,
				getCurrentUser: async () => testUser,
				permissionSetResolver: {
					resolve: async (nsid) =>
						nsid === "com.example.basic" ? mockSet : null,
				},
			});

			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set(
				"scope",
				"atproto include:com.example.basic?aud=did:web:foo%23svc",
			);
			formData.set("action", "allow");

			const authResponse = await localProvider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			expect(authResponse.status).toBe(302);
			const code = new URL(
				authResponse.headers.get("Location")!,
			).searchParams.get("code")!;

			const dpopProof = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256",
			);
			const tokenResponse = await localProvider.handleToken(
				new Request("https://pds.example.com/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						DPoP: dpopProof,
					},
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code,
						client_id: testClient.clientId,
						redirect_uri: testClient.redirectUris[0]!,
						code_verifier: verifier,
					}).toString(),
				}),
			);
			const tokens = (await tokenResponse.json()) as { access_token: string };

			const stored = await localStorage.getTokenByAccess(tokens.access_token);
			expect(stored).not.toBeNull();
			// Stored scope should be expanded (no include:), and contain the
			// concrete repo permission from the bundle.
			expect(stored!.scope).not.toMatch(/include:/);
			expect(stored!.scope).toMatch(/repo:com\.example\.post/);
		});

		it("rejects an include: that fails to resolve", async () => {
			const localStorage = new InMemoryOAuthStorage();
			const localResolver = new MockClientResolver({});
			localResolver.registerClient(testClient);
			const localProvider = new ATProtoOAuthProvider({
				storage: localStorage,
				issuer: "https://pds.example.com",
				dpopRequired: true,
				enablePAR: false,
				clientResolver: localResolver,
				getCurrentUser: async () => testUser,
				permissionSetResolver: {
					resolve: async () => null,
				},
			});

			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set(
				"scope",
				"atproto include:com.example.missing?aud=did:web:foo%23svc",
			);
			formData.set("action", "allow");

			const response = await localProvider.handleAuthorize(
				new Request("https://pds.example.com/oauth/authorize", {
					method: "POST",
					body: formData,
				}),
			);
			// Expansion failure happens at code-issuance time, so it's
			// reported via the OAuth redirect with `error=invalid_scope`.
			expect(response.status).toBe(302);
			const location = new URL(response.headers.get("Location")!);
			expect(location.searchParams.get("error")).toBe("invalid_scope");
			expect(location.searchParams.get("error_description")).toMatch(
				/com\.example\.missing/,
			);
		});

		it("PAR rejects malformed granular scope", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const parBody = new URLSearchParams({
				client_id: testClient.clientId,
				redirect_uri: testClient.redirectUris[0]!,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "test-state",
				scope: "atproto repo:not a real nsid",
			});
			const response = await provider.handlePAR(
				new Request("https://pds.example.com/oauth/par", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: parBody.toString(),
				}),
			);
			expect(response.status).toBe(400);
			const json = (await response.json()) as { error: string };
			expect(json.error).toBe("invalid_scope");
		});
	});
});
