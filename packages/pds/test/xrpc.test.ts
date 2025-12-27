import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";

describe("XRPC Endpoints", () => {
	describe("Health Check", () => {
		it("should return status and version", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/health"),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				status: "ok",
				version: expect.any(String),
			});
		});
	});

	describe("Server Identity", () => {
		it("should describe server", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.server.describeServer"),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				did: env.DID,
				availableUserDomains: [],
				inviteCodeRequired: false,
			});
		});

		it("should resolve handle", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=${env.HANDLE}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toEqual({
				did: env.DID,
			});
		});

		it("should return 404 for unknown handle", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=bob.test",
				),
				env,
			);
			expect(response.status).toBe(404);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "HandleNotFound",
			});
		});
	});

	describe("Repository Operations", () => {
		it("should describe repo", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.describeRepo?repo=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data).toMatchObject({
				did: env.DID,
				handle: env.HANDLE,
				handleIsCorrect: true,
			});
			expect(data.collections).toEqual([]);
		});

		it("should create a record", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						record: {
							text: "Hello, World!",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				uri: expect.stringMatching(
					new RegExp(
						`^at://${env.DID.replace(/[:.]/g, "\\$&")}/app\\.bsky\\.feed\\.post/.+$`,
					),
				),
				cid: expect.any(String),
			});
		});

		it("should require auth for createRecord", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						record: {
							text: "Hello, World!",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);
			expect(response.status).toBe(401);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "AuthMissing",
			});
		});

		it("should get a record", async () => {
			// First create a record
			await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "test-post-1",
						record: {
							text: "Test post",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Now get it
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=test-post-1`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				uri: `at://${env.DID}/app.bsky.feed.post/test-post-1`,
				cid: expect.any(String),
				value: {
					text: "Test post",
				},
			});
		});

		it("should list records", async () => {
			// Create a few records
			for (let i = 1; i <= 3; i++) {
				await worker.fetch(
					new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({
							repo: env.DID,
							collection: "app.bsky.feed.post",
							rkey: `post-${i}`,
							record: {
								text: `Post ${i}`,
								createdAt: new Date().toISOString(),
							},
						}),
					}),
					env,
				);
			}

			// List them
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.listRecords?repo=${env.DID}&collection=app.bsky.feed.post`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			// Records persist across tests, so we have at least 3
			expect(data.records.length).toBeGreaterThanOrEqual(3);
			// Verify our specific records are present
			const ourRecords = data.records.filter((r: any) =>
				r.uri.match(/\/post-[123]$/),
			);
			expect(ourRecords).toHaveLength(3);
			expect(ourRecords[0]).toMatchObject({
				uri: expect.stringMatching(
					new RegExp(
						`^at://${env.DID.replace(/[:.]/g, "\\$&")}/app\\.bsky\\.feed\\.post/.+$`,
					),
				),
				value: {
					text: expect.stringMatching(/^Post \d$/),
				},
			});
		});

		it("should delete a record", async () => {
			// Create a record
			await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "to-delete",
						record: {
							text: "Delete me",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Delete it
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.deleteRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "to-delete",
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			// Verify it's gone
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=to-delete`,
				),
				env,
			);
			expect(getResponse.status).toBe(404);
		});
	});

	describe("Sync Endpoints", () => {
		it("should get repo status", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepoStatus?did=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				did: env.DID,
				active: true,
				status: "active",
				rev: expect.any(String),
			});
		});

		it("should export repo as CAR file", async () => {
			// Create a record first so the repo has some content
			await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "car-test",
						record: {
							text: "CAR export test",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Export repo
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"application/vnd.ipld.car",
			);

			const carData = await response.arrayBuffer();
			expect(carData.byteLength).toBeGreaterThan(0);
		});
	});
});
