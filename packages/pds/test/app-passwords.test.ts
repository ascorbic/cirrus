import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

/** Helper to get an access token for authenticated requests. */
async function getAccessToken(): Promise<string> {
	const res = await worker.fetch(
		new Request("http://pds.test/xrpc/com.atproto.server.createSession", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				identifier: "alice.test",
				password: "test-password",
			}),
		}),
		env,
	);
	const body = (await res.json()) as { accessJwt: string };
	return body.accessJwt;
}

/** Helper to create an app password and return the response body. */
async function createAppPassword(
	token: string,
	name: string,
): Promise<{ name: string; password: string; createdAt: string }> {
	const res = await worker.fetch(
		new Request(
			"http://pds.test/xrpc/com.atproto.server.createAppPassword",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ name }),
			},
		),
		env,
	);
	expect(res.status).toBe(200);
	return res.json() as Promise<{
		name: string;
		password: string;
		createdAt: string;
	}>;
}

describe("App Passwords", () => {
	describe("createAppPassword", () => {
		it("creates an app password and returns it in xxxx-xxxx-xxxx-xxxx format", async () => {
			const token = await getAccessToken();
			const body = await createAppPassword(token, "test-client");

			expect(body.name).toBe("test-client");
			expect(body.password).toMatch(
				/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/,
			);
			expect(body.createdAt).toBeDefined();
			// createdAt should be a valid ISO timestamp
			expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
		});

		it("requires authentication", async () => {
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createAppPassword",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "no-auth" }),
					},
				),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects missing name", async () => {
			const token = await getAccessToken();
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({}),
					},
				),
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
		});

		it("rejects empty name", async () => {
			const token = await getAccessToken();
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "   " }),
					},
				),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects duplicate names", async () => {
			const token = await getAccessToken();
			await createAppPassword(token, "duplicate-test");

			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "duplicate-test" }),
					},
				),
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toBe("DuplicateName");
		});
	});

	describe("listAppPasswords", () => {
		it("returns created app passwords", async () => {
			const token = await getAccessToken();
			const created = await createAppPassword(token, "list-test");

			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				),
				env,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				passwords: Array<{ name: string; createdAt: string }>;
			};
			expect(body.passwords).toBeDefined();
			expect(Array.isArray(body.passwords)).toBe(true);

			const found = body.passwords.find((p) => p.name === "list-test");
			expect(found).toBeDefined();
			expect(found!.createdAt).toBeDefined();
		});

		it("returns createdAt as an RFC 3339 datetime", async () => {
			const token = await getAccessToken();
			await createAppPassword(token, "iso-datetime-test");

			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				),
				env,
			);
			const body = (await res.json()) as {
				passwords: Array<{ name: string; createdAt: string }>;
			};
			const found = body.passwords.find((p) => p.name === "iso-datetime-test");
			expect(found).toBeDefined();
			// Must match the atproto datetime lexicon (RFC 3339), not the
			// "YYYY-MM-DD HH:MM:SS" form that SQLite's datetime('now') returns.
			expect(found!.createdAt).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
			);
			expect(new Date(found!.createdAt).toISOString()).toBe(found!.createdAt);
		});

		it("never exposes password hashes", async () => {
			const token = await getAccessToken();
			await createAppPassword(token, "hash-check");

			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				),
				env,
			);
			const body = (await res.json()) as {
				passwords: Array<Record<string, unknown>>;
			};
			for (const p of body.passwords) {
				expect(p).not.toHaveProperty("password");
				expect(p).not.toHaveProperty("passwordHash");
				expect(p).not.toHaveProperty("password_hash");
			}
		});

		it("requires authentication", async () => {
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
				),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("revokeAppPassword", () => {
		it("revokes an existing app password", async () => {
			const token = await getAccessToken();
			await createAppPassword(token, "revoke-test");

			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "revoke-test" }),
					},
				),
				env,
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({});

			// Verify it no longer appears in the list
			const listRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				),
				env,
			);
			const listBody = (await listRes.json()) as {
				passwords: Array<{ name: string }>;
			};
			expect(listBody.passwords.find((p) => p.name === "revoke-test")).toBeUndefined();
		});

		it("returns 400 for non-existent app password", async () => {
			const token = await getAccessToken();
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "does-not-exist" }),
					},
				),
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
		});

		it("rejects missing name", async () => {
			const token = await getAccessToken();
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({}),
					},
				),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("requires authentication", async () => {
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "no-auth" }),
					},
				),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("authentication with app passwords", () => {
		it("can create a session using an app password", async () => {
			const token = await getAccessToken();
			const { password } = await createAppPassword(token, "auth-test");

			// Login with the app password
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.accessJwt).toBeDefined();
			expect(body.refreshJwt).toBeDefined();
			expect(body.did).toBe("did:web:pds.test");
			expect(body.handle).toBe("alice.test");
		});

		it("can use app password session token for write operations", async () => {
			const token = await getAccessToken();
			const { password } = await createAppPassword(token, "write-test");

			// Login with app password
			const loginRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			const { accessJwt } = (await loginRes.json()) as {
				accessJwt: string;
			};

			// Use that token to create a record
			const createRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.repo.createRecord",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${accessJwt}`,
						},
						body: JSON.stringify({
							repo: "did:web:pds.test",
							collection: "app.bsky.feed.post",
							record: {
								$type: "app.bsky.feed.post",
								text: "Posted with app password",
								createdAt: new Date().toISOString(),
							},
						}),
					},
				),
				env,
			);
			expect(createRes.status).toBe(200);
			const record = (await createRes.json()) as Record<string, unknown>;
			expect(record.uri).toMatch(/^at:\/\//);
		});

		it("rejects invalid app password", async () => {
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password: "abcd-efgh-ijkl-mnop",
						}),
					},
				),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects a revoked app password", async () => {
			const token = await getAccessToken();
			const { password } = await createAppPassword(token, "revoke-auth");

			// Verify it works first
			const loginRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			expect(loginRes.status).toBe(200);

			// Revoke it
			await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "revoke-auth" }),
					},
				),
				env,
			);

			// Should no longer work
			const rejectedRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			expect(rejectedRes.status).toBe(401);
		});

		it("account password still works after creating app passwords", async () => {
			const token = await getAccessToken();
			await createAppPassword(token, "no-interference");

			// Account password should still work
			const res = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password: "test-password",
						}),
					},
				),
				env,
			);
			expect(res.status).toBe(200);
		});
	});

	describe("full lifecycle", () => {
		it("create, list, authenticate, revoke, reject", async () => {
			const token = await getAccessToken();

			// 1. Create
			const { password, name } = await createAppPassword(
				token,
				"lifecycle",
			);
			expect(name).toBe("lifecycle");

			// 2. List — should contain it
			const listRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.listAppPasswords",
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				),
				env,
			);
			const listBody = (await listRes.json()) as {
				passwords: Array<{ name: string }>;
			};
			expect(listBody.passwords.find((p) => p.name === "lifecycle")).toBeDefined();

			// 3. Authenticate with it
			const authRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			expect(authRes.status).toBe(200);

			// 4. Revoke
			const revokeRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.revokeAppPassword",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ name: "lifecycle" }),
					},
				),
				env,
			);
			expect(revokeRes.status).toBe(200);

			// 5. Authentication should now fail
			const rejectedRes = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.createSession",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							identifier: "alice.test",
							password,
						}),
					},
				),
				env,
			);
			expect(rejectedRes.status).toBe(401);
		});
	});
});
