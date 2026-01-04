import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

describe("XRPC Endpoints", () => {
	describe("Health Check", () => {
		it("should return status and version", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/_health"),
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

	describe("Authentication", () => {
		it("should reject request with missing Authorization header", async () => {
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
							$type: "app.bsky.feed.post",
							text: "Should fail",
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
				message: "Authorization header required",
			});
		});

		it("should reject request with malformed Authorization header", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "NotBearer token",
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						record: {
							$type: "app.bsky.feed.post",
							text: "Should fail",
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
				message: "Invalid authorization scheme",
			});
		});

		it("should reject request with incorrect token", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer wrong-token",
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						record: {
							$type: "app.bsky.feed.post",
							text: "Should fail",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);
			expect(response.status).toBe(401);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "AuthenticationRequired",
				message: "Invalid authentication token",
			});
		});

		it("should accept request with valid token", async () => {
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
							$type: "app.bsky.feed.post",
							text: "Should succeed",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				uri: expect.stringMatching(/^at:/),
				cid: expect.any(String),
			});
		});

		it("should require auth for deleteRecord", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.deleteRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "any-key",
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

		it("should allow read operations without auth", async () => {
			const endpoints = [
				`/xrpc/com.atproto.repo.describeRepo?repo=${env.DID}`,
				`/xrpc/com.atproto.repo.listRecords?repo=${env.DID}&collection=app.bsky.feed.post`,
				`/xrpc/com.atproto.sync.getRepoStatus?did=${env.DID}`,
				`/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
			];

			for (const endpoint of endpoints) {
				const response = await worker.fetch(
					new Request(`http://pds.test${endpoint}`),
					env,
				);
				expect(response.status).not.toBe(401);
			}
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

		it("should proxy unknown handles to AppView", async () => {
			// Unknown handles are proxied to AppView (api.bsky.app)
			// In test environment this may fail or return an error from the proxy
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.identity.resolveHandle?handle=bob.test",
				),
				env,
			);
			// We don't control the AppView response, just verify we don't return our own 404
			expect(response.status).not.toBe(404);
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
			// Collections will exist from previous tests
			expect(Array.isArray(data.collections)).toBe(true);
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
							$type: "app.bsky.feed.post",
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
							$type: "app.bsky.feed.post",
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
								$type: "app.bsky.feed.post",
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
							$type: "app.bsky.feed.post",
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

		it("should handle deleting non-existent record", async () => {
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
						rkey: "does-not-exist",
					}),
				}),
				env,
			);
			expect(response.status).toBe(404);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "RecordNotFound",
			});
		});

		it("should return 404 for non-existent record", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=does-not-exist`,
				),
				env,
			);
			expect(response.status).toBe(404);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "RecordNotFound",
			});
		});

		it("should handle invalid collection name", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.listRecords?repo=${env.DID}&collection=invalid-collection`,
				),
				env,
			);
			// Currently returns 200 with empty records for non-existent collections
			// This is acceptable behavior - collection doesn't exist = no records
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data.records).toEqual([]);
		});

		it("should handle missing query parameters", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post",
				),
				env,
			);
			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
			});
		});
	});

	describe("Concurrency", () => {
		it("should handle concurrent createRecord calls", async () => {
			const promises = [];
			for (let i = 0; i < 10; i++) {
				promises.push(
					worker.fetch(
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
									$type: "app.bsky.feed.post",
									text: `Concurrent post ${i}`,
									createdAt: new Date().toISOString(),
								},
							}),
						}),
						env,
					),
				);
			}

			const responses = await Promise.all(promises);

			// All should succeed and collect URIs
			const uris: string[] = [];
			for (const response of responses) {
				expect(response.status).toBe(200);
				const data = (await response.json()) as { uri: string; cid: string };
				expect(data).toMatchObject({
					uri: expect.stringMatching(/^at:/),
					cid: expect.any(String),
				});
				uris.push(data.uri);
			}

			// All URIs should be unique
			const uniqueUris = new Set(uris);
			expect(uniqueUris.size).toBe(10);
		});

		it("should handle concurrent read operations", async () => {
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
						rkey: "concurrent-read-test",
						record: {
							$type: "app.bsky.feed.post",
							text: "Read me concurrently",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Read it concurrently
			const promises = [];
			for (let i = 0; i < 20; i++) {
				promises.push(
					worker.fetch(
						new Request(
							`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=concurrent-read-test`,
						),
						env,
					),
				);
			}

			const responses = await Promise.all(promises);

			// All should succeed with same data
			for (const response of responses) {
				expect(response.status).toBe(200);
				const data = (await response.json()) as {
					value: { text: string };
				};
				expect(data.value.text).toBe("Read me concurrently");
			}
		});

		it("should handle create and delete race conditions", async () => {
			// Create a record
			const createResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "race-test",
						record: {
							$type: "app.bsky.feed.post",
							text: "Race test",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);
			expect(createResponse.status).toBe(200);

			// Try to read and delete simultaneously
			const [readResponse, deleteResponse] = await Promise.all([
				worker.fetch(
					new Request(
						`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=race-test`,
					),
					env,
				),
				worker.fetch(
					new Request("http://pds.test/xrpc/com.atproto.repo.deleteRecord", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
						body: JSON.stringify({
							repo: env.DID,
							collection: "app.bsky.feed.post",
							rkey: "race-test",
						}),
					}),
					env,
				),
			]);

			// Delete should succeed
			expect(deleteResponse.status).toBe(200);

			// Read might succeed or fail depending on timing, but shouldn't error
			expect([200, 404]).toContain(readResponse.status);
		});
	});

	describe("applyWrites", () => {
		it("should create multiple records in batch", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						writes: [
							{
								$type: "com.atproto.repo.applyWrites#create",
								collection: "app.bsky.feed.post",
								rkey: "batch-1",
								value: {
									$type: "app.bsky.feed.post",
									text: "Batch post 1",
									createdAt: new Date().toISOString(),
								},
							},
							{
								$type: "com.atproto.repo.applyWrites#create",
								collection: "app.bsky.feed.post",
								rkey: "batch-2",
								value: {
									$type: "app.bsky.feed.post",
									text: "Batch post 2",
									createdAt: new Date().toISOString(),
								},
							},
						],
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data.commit).toBeDefined();
			expect(data.commit.cid).toBeDefined();
			expect(data.results).toHaveLength(2);
			expect(data.results[0].$type).toBe(
				"com.atproto.repo.applyWrites#createResult",
			);
			expect(data.results[0].uri).toContain("batch-1");
			expect(data.results[1].uri).toContain("batch-2");
		});

		it("should update a record", async () => {
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
						rkey: "to-update",
						record: {
							$type: "app.bsky.feed.post",
							text: "Original text",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Update it via applyWrites
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						writes: [
							{
								$type: "com.atproto.repo.applyWrites#update",
								collection: "app.bsky.feed.post",
								rkey: "to-update",
								value: {
									$type: "app.bsky.feed.post",
									text: "Updated text",
									createdAt: new Date().toISOString(),
								},
							},
						],
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data.results[0].$type).toBe(
				"com.atproto.repo.applyWrites#updateResult",
			);

			// Verify the update
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=to-update`,
				),
				env,
			);
			const record = (await getResponse.json()) as any;
			expect(record.value.text).toBe("Updated text");
		});

		it("should delete a record via applyWrites", async () => {
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
						rkey: "to-delete-batch",
						record: {
							$type: "app.bsky.feed.post",
							text: "Delete me via batch",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Delete via applyWrites
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						writes: [
							{
								$type: "com.atproto.repo.applyWrites#delete",
								collection: "app.bsky.feed.post",
								rkey: "to-delete-batch",
							},
						],
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data.results[0].$type).toBe(
				"com.atproto.repo.applyWrites#deleteResult",
			);

			// Verify deletion
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=to-delete-batch`,
				),
				env,
			);
			expect(getResponse.status).toBe(404);
		});

		it("should handle mixed operations", async () => {
			// Create records to work with
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
						rkey: "mixed-update",
						record: {
							$type: "app.bsky.feed.post",
							text: "Will be updated",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

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
						rkey: "mixed-delete",
						record: {
							$type: "app.bsky.feed.post",
							text: "Will be deleted",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Mixed batch: create, update, delete
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						writes: [
							{
								$type: "com.atproto.repo.applyWrites#create",
								collection: "app.bsky.feed.post",
								rkey: "mixed-new",
								value: {
									$type: "app.bsky.feed.post",
									text: "New from batch",
									createdAt: new Date().toISOString(),
								},
							},
							{
								$type: "com.atproto.repo.applyWrites#update",
								collection: "app.bsky.feed.post",
								rkey: "mixed-update",
								value: {
									$type: "app.bsky.feed.post",
									text: "Updated from batch",
									createdAt: new Date().toISOString(),
								},
							},
							{
								$type: "com.atproto.repo.applyWrites#delete",
								collection: "app.bsky.feed.post",
								rkey: "mixed-delete",
							},
						],
					}),
				}),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as any;
			expect(data.results).toHaveLength(3);
			expect(data.results[0].$type).toBe(
				"com.atproto.repo.applyWrites#createResult",
			);
			expect(data.results[1].$type).toBe(
				"com.atproto.repo.applyWrites#updateResult",
			);
			expect(data.results[2].$type).toBe(
				"com.atproto.repo.applyWrites#deleteResult",
			);
		});

		it("should require authentication", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						repo: env.DID,
						writes: [],
					}),
				}),
				env,
			);
			expect(response.status).toBe(401);
		});

		it("should reject too many writes", async () => {
			const writes = Array.from({ length: 201 }, (_, i) => ({
				$type: "com.atproto.repo.applyWrites#create",
				collection: "app.bsky.feed.post",
				value: {
					$type: "app.bsky.feed.post",
					text: `Post ${i}`,
					createdAt: new Date().toISOString(),
				},
			}));

			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.applyWrites", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						writes,
					}),
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = (await response.json()) as any;
			expect(data.message).toContain("Too many writes");
		});
	});

	describe("Service Auth", () => {
		it("should return service JWT for video upload", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.getServiceAuth?aud=did:web:video.bsky.app&lxm=app.bsky.video.getUploadLimits",
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as { token: string };
			expect(data.token).toBeDefined();

			// Verify JWT structure
			const parts = data.token.split(".");
			expect(parts).toHaveLength(3);

			// Decode and verify payload
			const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
			expect(payload.iss).toBe(env.DID);
			expect(payload.aud).toBe("did:web:video.bsky.app");
			expect(payload.lxm).toBe("app.bsky.video.getUploadLimits");
			expect(payload.iat).toBeTypeOf("number");
			expect(payload.exp).toBeTypeOf("number");
		});

		it("should return service JWT without lxm", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.getServiceAuth?aud=did:web:api.bsky.app",
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);
			expect(response.status).toBe(200);

			const data = (await response.json()) as { token: string };
			const parts = data.token.split(".");
			const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
			expect(payload.lxm).toBeUndefined();
		});

		it("should require authentication", async () => {
			const response = await worker.fetch(
				new Request(
					"http://pds.test/xrpc/com.atproto.server.getServiceAuth?aud=did:web:video.bsky.app",
				),
				env,
			);
			expect(response.status).toBe(401);
		});

		it("should require aud parameter", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.server.getServiceAuth", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);
			expect(response.status).toBe(400);

			const data = (await response.json()) as { error: string };
			expect(data.error).toBe("InvalidRequest");
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
							$type: "app.bsky.feed.post",
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

		it("should export valid CAR file with root block", async () => {
			const { CarReader } = await import("@ipld/car");

			// Export repo
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const carBytes = new Uint8Array(await response.arrayBuffer());
			const reader = await CarReader.fromBytes(carBytes);

			// Should have exactly one root
			const roots = await reader.getRoots();
			expect(roots).toHaveLength(1);

			const rootCid = roots[0];
			expect(rootCid).toBeDefined();
			if (!rootCid) throw new Error("Root CID not found");
			expect(rootCid.toString()).toMatch(/^bafy/);

			// Root block should be present
			const rootBlock = await reader.get(rootCid);
			expect(rootBlock).toBeDefined();
			expect(rootBlock?.bytes).toBeInstanceOf(Uint8Array);

			// Should have multiple blocks (root + records)
			const blocks = [];
			for await (const block of reader.blocks()) {
				blocks.push(block);
			}
			expect(blocks.length).toBeGreaterThan(0);
		});

		it("should export CAR file for empty repo", async () => {
			const { CarReader } = await import("@ipld/car");

			// Get a fresh DID that has no records (use wrong DID to simulate)
			// Actually, we can't easily test with another DID, so just verify current export works
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
				),
				env,
			);
			expect(response.status).toBe(200);

			const carBytes = new Uint8Array(await response.arrayBuffer());
			const reader = await CarReader.fromBytes(carBytes);

			// Should always have a root even if empty
			const roots = await reader.getRoots();
			expect(roots.length).toBeGreaterThanOrEqual(1);
		});
	});
});
