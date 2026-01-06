import { describe, it, expect, vi } from "vitest";
import { ClientResolver } from "../src/client-resolver.js";
import type { OAuthStorage, ClientMetadata } from "../src/storage.js";

describe("ClientResolver", () => {
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
