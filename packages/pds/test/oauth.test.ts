import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

describe("OAuth 2.1 Endpoints", () => {
	describe("Server Metadata", () => {
		it("should return OAuth authorization server metadata", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/.well-known/oauth-authorization-server"),
				env,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toContain(
				"application/json",
			);

			const metadata = await response.json();
			expect(metadata).toMatchObject({
				issuer: `https://${env.PDS_HOSTNAME}`,
				authorization_endpoint: expect.stringContaining("/oauth/authorize"),
				token_endpoint: expect.stringContaining("/oauth/token"),
				response_types_supported: ["code"],
				grant_types_supported: expect.arrayContaining([
					"authorization_code",
					"refresh_token",
				]),
				code_challenge_methods_supported: ["S256"],
				scopes_supported: expect.arrayContaining(["atproto"]),
			});
		});

		it("should include PAR endpoint in metadata", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/.well-known/oauth-authorization-server"),
				env,
			);
			const metadata = await response.json();
			expect(metadata.pushed_authorization_request_endpoint).toContain(
				"/oauth/par",
			);
		});

		it("should return protected resource metadata", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/.well-known/oauth-protected-resource"),
				env,
			);
			expect(response.status).toBe(200);

			const metadata = await response.json();
			expect(metadata).toMatchObject({
				resource: `https://${env.PDS_HOSTNAME}`,
				authorization_servers: [`https://${env.PDS_HOSTNAME}`],
				scopes_supported: expect.arrayContaining(["atproto"]),
			});
		});
	});

	describe("Authorization Endpoint", () => {
		it("should require client_id parameter", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/authorize?response_type=code"),
				env,
			);
			expect(response.status).toBe(400);
		});

		it("should require redirect_uri parameter", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/oauth/authorize?response_type=code&client_id=did:web:test.example",
				),
				env,
			);
			expect(response.status).toBe(400);
		});

		it("should require code_challenge for PKCE", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/oauth/authorize?response_type=code&client_id=did:web:test.example&redirect_uri=http://localhost/callback&state=test123",
				),
				env,
			);
			expect(response.status).toBe(400);
		});
	});

	describe("Token Endpoint", () => {
		it("should accept JSON body", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ grant_type: "authorization_code" }),
				}),
				env,
			);
			// Should fail for missing params, not content type
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toBe("invalid_request");
			expect(data.error_description).toContain("code");
		});

		it("should reject unsupported grant types", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "grant_type=password",
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toBe("unsupported_grant_type");
		});

		it("should require code for authorization_code grant", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "grant_type=authorization_code",
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toBe("invalid_request");
			expect(data.error_description).toContain("code");
		});

		it("should require refresh_token for refresh grant", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "grant_type=refresh_token",
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toBe("invalid_request");
			expect(data.error_description).toContain("refresh_token");
		});
	});

	describe("PAR Endpoint", () => {
		it("should accept JSON body", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/par", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ client_id: "did:web:test" }),
				}),
				env,
			);
			// Should fail for missing params, not content type
			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toBe("invalid_request");
			expect(data.error_description).toContain("redirect_uri");
		});

		it("should require client_id", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/par", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "response_type=code",
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toBe("invalid_request");
		});
	});

	describe("Token Revocation", () => {
		it("should return success even for unknown tokens (RFC 7009)", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/revoke", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "token=nonexistent-token",
				}),
				env,
			);
			// RFC 7009 says to return 200 even if token doesn't exist
			expect(response.status).toBe(200);
		});

		it("should return success for empty token", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/oauth/revoke", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "",
				}),
				env,
			);
			expect(response.status).toBe(200);
		});
	});
});
