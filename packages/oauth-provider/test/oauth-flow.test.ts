import { describe, it, expect, beforeEach } from "vitest";
import { ATProtoOAuthProvider } from "../src/provider.js";
import { InMemoryOAuthStorage, type ClientMetadata } from "../src/storage.js";
import { generateCodeChallenge, generateCodeVerifier } from "../src/pkce.js";
import { createDpopProof, generateDpopKeyPair } from "../src/dpop.js";
import { ClientResolver } from "../src/client-resolver.js";

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
		it("returns consent UI for GET request", async () => {
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

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toContain("text/html");

			const html = await response.text();
			expect(html).toContain(testClient.clientName);
		});

		it("redirects with code after consent approval", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const url = new URL("https://pds.example.com/oauth/authorize");

			// Form data includes all OAuth params (like hidden form fields in the UI)
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set("action", "allow");

			const request = new Request(url.toString(), {
				method: "POST",
				body: formData,
			});
			const response = await provider.handleAuthorize(request);

			expect(response.status).toBe(302);
			const location = response.headers.get("Location");
			expect(location).toBeDefined();

			const redirectUrl = new URL(location!);
			expect(redirectUrl.searchParams.has("code")).toBe(true);
			expect(redirectUrl.searchParams.get("state")).toBe("test-state");
		});

		it("redirects with error after consent denial", async () => {
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);

			const url = new URL("https://pds.example.com/oauth/authorize");

			// Form data includes all OAuth params (like hidden form fields in the UI)
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set("action", "deny");

			const request = new Request(url.toString(), {
				method: "POST",
				body: formData,
			});
			const response = await provider.handleAuthorize(request);

			expect(response.status).toBe(302);
			const location = response.headers.get("Location");
			const redirectUrl = new URL(location!);
			expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
		});
	});

	describe("Token Endpoint", () => {
		async function getAuthCode(
			verifier: string
		): Promise<{ code: string; challenge: string }> {
			const challenge = await generateCodeChallenge(verifier);

			const url = new URL("https://pds.example.com/oauth/authorize");

			// Form data includes all OAuth params (like hidden form fields in the UI)
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set("action", "allow");

			const request = new Request(url.toString(), {
				method: "POST",
				body: formData,
			});
			const response = await provider.handleAuthorize(request);
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
				"ES256"
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
				"ES256"
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
				"ES256"
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
				"ES256"
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
				"ES256"
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
				"ES256"
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

			const json2 = (await response2.json()) as { access_token: string; refresh_token: string };
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
			expect(json.authorization_endpoint).toBe("https://pds.example.com/oauth/authorize");
			expect(json.token_endpoint).toBe("https://pds.example.com/oauth/token");
			expect(json.pushed_authorization_request_endpoint).toBe(
				"https://pds.example.com/oauth/par"
			);
			expect(json.response_types_supported).toContain("code");
			expect(json.code_challenge_methods_supported).toContain("S256");
			expect(json.dpop_signing_alg_values_supported).toContain("ES256");
		});
	});

	describe("Token Verification", () => {
		it("verifies valid DPoP-bound access token", async () => {
			// Get tokens
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair = await generateDpopKeyPair("ES256");

			const url = new URL("https://pds.example.com/oauth/authorize");

			// Form data includes all OAuth params (like hidden form fields in the UI)
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set("action", "allow");

			const authRequest = new Request(url.toString(), {
				method: "POST",
				body: formData,
			});
			const authResponse = await provider.handleAuthorize(authRequest);
			const location = authResponse.headers.get("Location")!;
			const code = new URL(location).searchParams.get("code")!;

			const dpopProof1 = await createDpopProof(
				keyPair.privateKey,
				keyPair.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256"
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
				new TextEncoder().encode(tokens.access_token)
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
				"ES256"
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
			// Get tokens with one key
			const verifier = generateCodeVerifier();
			const challenge = await generateCodeChallenge(verifier);
			const keyPair1 = await generateDpopKeyPair("ES256");

			const url = new URL("https://pds.example.com/oauth/authorize");

			// Form data includes all OAuth params (like hidden form fields in the UI)
			const formData = new FormData();
			formData.set("client_id", testClient.clientId);
			formData.set("redirect_uri", testClient.redirectUris[0]!);
			formData.set("response_type", "code");
			formData.set("code_challenge", challenge);
			formData.set("code_challenge_method", "S256");
			formData.set("state", "test-state");
			formData.set("action", "allow");

			const authRequest = new Request(url.toString(), {
				method: "POST",
				body: formData,
			});
			const authResponse = await provider.handleAuthorize(authRequest);
			const location = authResponse.headers.get("Location")!;
			const code = new URL(location).searchParams.get("code")!;

			const dpopProof1 = await createDpopProof(
				keyPair1.privateKey,
				keyPair1.publicJwk,
				{ htm: "POST", htu: "https://pds.example.com/oauth/token" },
				"ES256"
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
				new TextEncoder().encode(tokens.access_token)
			);
			const ath = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const dpopProof2 = await createDpopProof(
				keyPair2.privateKey,
				keyPair2.publicJwk,
				{ htm: "GET", htu: "https://pds.example.com/api/resource", ath },
				"ES256"
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
});
