import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "./helpers";
import { AccountDurableObject } from "../src/account-do";

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
					// Access raw SQLite to verify row existence directly
					// (getTokenByAccess returns null for revoked tokens even before cleanup)
					const sql = (instance as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;

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

					// Verify the row still exists in the database (revoked but not yet cleaned up)
					const beforeCleanup = sql
						.exec(
							"SELECT access_token, revoked FROM oauth_tokens WHERE access_token = ?",
							"revoked-access",
						)
						.toArray();
					expect(beforeCleanup).toHaveLength(1);
					expect(beforeCleanup[0]!.revoked).toBe(1);

					// Run cleanup — should delete all revoked tokens
					storage.cleanup();

					// Verify the row was actually deleted from the database
					const afterCleanup = sql
						.exec(
							"SELECT access_token FROM oauth_tokens WHERE access_token = ?",
							"revoked-access",
						)
						.toArray();
					expect(afterCleanup).toHaveLength(0);
				},
			);
		});
	});
});
