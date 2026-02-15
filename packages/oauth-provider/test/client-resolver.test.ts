import { describe, it, expect, vi } from "vitest";
import { ClientResolver } from "../src/client-resolver.js";
import type { OAuthStorage, ClientMetadata } from "../src/storage.js";

describe("ClientResolver", () => {
	describe("localhost clients", () => {
		it("resolves localhost client from URL without network request", async () => {
			const clientId =
				"http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fcallback&scope=atproto";

			const mockFetch = vi.fn();
			const resolver = new ClientResolver({
				fetch: mockFetch as unknown as typeof fetch,
			});

			const result = await resolver.resolveClient(clientId);

			// Should NOT make any network request
			expect(mockFetch).not.toHaveBeenCalled();

			// Should parse metadata from URL
			expect(result.clientId).toBe(clientId);
			expect(result.clientName).toBe("Localhost Client");
			expect(result.redirectUris).toEqual(["http://127.0.0.1:8080/callback"]);
			expect(result.tokenEndpointAuthMethod).toBe("none");
		});

		it("uses default redirect URIs when none specified", async () => {
			const clientId = "http://localhost";

			const resolver = new ClientResolver();
			const result = await resolver.resolveClient(clientId);

			expect(result.redirectUris).toEqual([
				"http://127.0.0.1/",
				"http://[::1]/",
			]);
		});

		it("rejects localhost with port number", async () => {
			const clientId = "http://localhost:3000";

			const resolver = new ClientResolver();

			await expect(resolver.resolveClient(clientId)).rejects.toThrow(
				"Invalid client ID format",
			);
		});

		it("does not treat https://localhost as localhost client", async () => {
			// Localhost clients must use http, not https
			// https://localhost is treated as a normal HTTPS client and fetched
			const clientId = "https://localhost";

			const mockFetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
			const resolver = new ClientResolver({
				fetch: mockFetch as unknown as typeof fetch,
			});

			await expect(resolver.resolveClient(clientId)).rejects.toThrow();

			// Should try to fetch (not treated as localhost client)
			expect(mockFetch).toHaveBeenCalled();
		});
	});

	describe("localhost redirect URI validation", () => {
		it("matches redirect URI ignoring port number", async () => {
			const clientId =
				"http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback";

			const resolver = new ClientResolver();

			// Should match with any port
			expect(
				await resolver.validateRedirectUri(
					clientId,
					"http://127.0.0.1/callback",
				),
			).toBe(true);
			expect(
				await resolver.validateRedirectUri(
					clientId,
					"http://127.0.0.1:8080/callback",
				),
			).toBe(true);
			expect(
				await resolver.validateRedirectUri(
					clientId,
					"http://127.0.0.1:19284/callback",
				),
			).toBe(true);

			// Should not match different path
			expect(
				await resolver.validateRedirectUri(clientId, "http://127.0.0.1/other"),
			).toBe(false);

			// Should not match different scheme
			expect(
				await resolver.validateRedirectUri(
					clientId,
					"https://127.0.0.1/callback",
				),
			).toBe(false);
		});

		it("matches default redirect URIs for localhost client", async () => {
			const clientId = "http://localhost";

			const resolver = new ClientResolver();

			// Default redirect URIs are http://127.0.0.1/ and http://[::1]/
			expect(
				await resolver.validateRedirectUri(clientId, "http://127.0.0.1/"),
			).toBe(true);
			expect(
				await resolver.validateRedirectUri(clientId, "http://127.0.0.1:3000/"),
			).toBe(true);
			expect(
				await resolver.validateRedirectUri(clientId, "http://[::1]/"),
			).toBe(true);
			expect(
				await resolver.validateRedirectUri(clientId, "http://[::1]:8080/"),
			).toBe(true);
		});
	});

	describe("cache invalidation", () => {
		it("re-fetches cached client without tokenEndpointAuthMethod", async () => {
			// This test ensures we don't use stale cache entries from before
			// we added tokenEndpointAuthMethod support
			const clientId = "https://example.com/oauth/metadata";

			// Stale cache entry (missing tokenEndpointAuthMethod)
			const staleClient: ClientMetadata = {
				clientId,
				clientName: "Example Client",
				redirectUris: ["https://example.com/callback"],
				cachedAt: Date.now(), // Fresh timestamp
				// Note: tokenEndpointAuthMethod is missing!
			};

			// Fresh metadata from server
			const freshMetadata = {
				client_id: clientId,
				client_name: "Example Client",
				redirect_uris: ["https://example.com/callback"],
				token_endpoint_auth_method: "private_key_jwt",
				jwks_uri: "https://example.com/jwks",
			};

			const mockStorage: OAuthStorage = {
				getClient: vi.fn().mockResolvedValue(staleClient),
				saveClient: vi.fn(),
				saveAuthCode: vi.fn(),
				getAuthCode: vi.fn(),
				deleteAuthCode: vi.fn(),
				saveTokens: vi.fn(),
				getTokenByAccess: vi.fn(),
				getTokenByRefresh: vi.fn(),
				revokeToken: vi.fn(),
				revokeAllTokens: vi.fn(),
				savePAR: vi.fn(),
				getPAR: vi.fn(),
				deletePAR: vi.fn(),
				checkAndSaveNonce: vi.fn(),
			};

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(freshMetadata),
			});

			const resolver = new ClientResolver({
				storage: mockStorage,
				fetch: mockFetch as unknown as typeof fetch,
			});

			const result = await resolver.resolveClient(clientId);

			// Should have fetched fresh metadata (cache was invalid)
			expect(mockFetch).toHaveBeenCalledWith(clientId, expect.any(Object));

			// Should return the fresh data with tokenEndpointAuthMethod
			expect(result.tokenEndpointAuthMethod).toBe("private_key_jwt");
			expect(result.jwksUri).toBe("https://example.com/jwks");

			// Should have saved the fresh metadata to cache
			expect(mockStorage.saveClient).toHaveBeenCalled();
		});

		it("uses valid cache entry with tokenEndpointAuthMethod", async () => {
			const clientId = "https://example.com/oauth/metadata";

			// Valid cache entry (has tokenEndpointAuthMethod)
			const cachedClient: ClientMetadata = {
				clientId,
				clientName: "Example Client",
				redirectUris: ["https://example.com/callback"],
				tokenEndpointAuthMethod: "private_key_jwt",
				jwksUri: "https://example.com/jwks",
				cachedAt: Date.now(),
			};

			const mockStorage: OAuthStorage = {
				getClient: vi.fn().mockResolvedValue(cachedClient),
				saveClient: vi.fn(),
				saveAuthCode: vi.fn(),
				getAuthCode: vi.fn(),
				deleteAuthCode: vi.fn(),
				saveTokens: vi.fn(),
				getTokenByAccess: vi.fn(),
				getTokenByRefresh: vi.fn(),
				revokeToken: vi.fn(),
				revokeAllTokens: vi.fn(),
				savePAR: vi.fn(),
				getPAR: vi.fn(),
				deletePAR: vi.fn(),
				checkAndSaveNonce: vi.fn(),
			};

			const mockFetch = vi.fn();

			const resolver = new ClientResolver({
				storage: mockStorage,
				fetch: mockFetch as unknown as typeof fetch,
			});

			const result = await resolver.resolveClient(clientId);

			// Should NOT have fetched (cache was valid)
			expect(mockFetch).not.toHaveBeenCalled();

			// Should return cached data
			expect(result).toBe(cachedClient);
		});

		it("uses cache entry with tokenEndpointAuthMethod set to none", async () => {
			const clientId = "https://example.com/oauth/metadata";

			// Valid cache entry for public client (tokenEndpointAuthMethod: "none")
			const cachedClient: ClientMetadata = {
				clientId,
				clientName: "Public Client",
				redirectUris: ["https://example.com/callback"],
				tokenEndpointAuthMethod: "none",
				cachedAt: Date.now(),
			};

			const mockStorage: OAuthStorage = {
				getClient: vi.fn().mockResolvedValue(cachedClient),
				saveClient: vi.fn(),
				saveAuthCode: vi.fn(),
				getAuthCode: vi.fn(),
				deleteAuthCode: vi.fn(),
				saveTokens: vi.fn(),
				getTokenByAccess: vi.fn(),
				getTokenByRefresh: vi.fn(),
				revokeToken: vi.fn(),
				revokeAllTokens: vi.fn(),
				savePAR: vi.fn(),
				getPAR: vi.fn(),
				deletePAR: vi.fn(),
				checkAndSaveNonce: vi.fn(),
			};

			const mockFetch = vi.fn();

			const resolver = new ClientResolver({
				storage: mockStorage,
				fetch: mockFetch as unknown as typeof fetch,
			});

			const result = await resolver.resolveClient(clientId);

			// Should NOT have fetched (cache was valid)
			expect(mockFetch).not.toHaveBeenCalled();

			// Should return cached data
			expect(result.tokenEndpointAuthMethod).toBe("none");
		});
	});
});
