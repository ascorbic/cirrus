import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "./helpers";
import { AccountDurableObject } from "../src/account-do";
import { SqliteOAuthStorage } from "../src/oauth-storage";

describe("SqliteOAuthStorage", () => {
	describe("cleanup", () => {
		it("should not delete non-revoked tokens with expired access tokens", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(
				stub,
				async (instance: AccountDurableObject) => {
					const storage = await instance.getOAuthStorage();

					// Save a token with an expired access token but not revoked
					const expiredAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
					await storage.saveTokens({
						accessToken: "expired-access",
						refreshToken: "valid-refresh",
						clientId: "test-client",
						sub: "did:web:test",
						scope: "atproto",
						issuedAt: expiredAt - 60 * 60 * 1000,
						expiresAt: expiredAt,
						revoked: false,
					});

					// Verify token exists via refresh token lookup
					const beforeCleanup =
						await storage.getTokenByRefresh("valid-refresh");
					expect(beforeCleanup).not.toBeNull();
					expect(beforeCleanup?.refreshToken).toBe("valid-refresh");

					// Run cleanup
					storage.cleanup();

					// Token should still exist — refresh token is still valid
					const afterCleanup =
						await storage.getTokenByRefresh("valid-refresh");
					expect(afterCleanup).not.toBeNull();
					expect(afterCleanup?.refreshToken).toBe("valid-refresh");
				},
			);
		});

		it("should delete all revoked tokens regardless of expiry", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(
				stub,
				async (instance: AccountDurableObject) => {
					const storage = await instance.getOAuthStorage();

					// Save a revoked token with a future expiry (access token not yet expired)
					const futureExpiry = Date.now() + 60 * 60 * 1000; // 1 hour from now
					await storage.saveTokens({
						accessToken: "revoked-access",
						refreshToken: "revoked-refresh",
						clientId: "test-client",
						sub: "did:web:test",
						scope: "atproto",
						issuedAt: Date.now(),
						expiresAt: futureExpiry,
						revoked: false,
					});

					// Revoke it
					await storage.revokeToken("revoked-access");

					// Verify it's revoked (getTokenByRefresh returns null for revoked)
					const revoked =
						await storage.getTokenByRefresh("revoked-refresh");
					expect(revoked).toBeNull();

					// Run cleanup — should delete all revoked tokens
					storage.cleanup();

					// Token row should be gone from the database entirely
					const afterCleanup =
						await storage.getTokenByAccess("revoked-access");
					expect(afterCleanup).toBeNull();
				},
			);
		});
	});
});
