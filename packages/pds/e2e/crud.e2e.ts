import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import { AtUri } from "@atproto/syntax";
import {
	createAgent,
	TEST_DID,
	TEST_HANDLE,
	TEST_PASSWORD,
	uniqueRkey,
} from "./helpers";

describe("CRUD Operations", () => {
	let agent: AtpAgent;

	beforeAll(async () => {
		agent = createAgent();
		// Login with session auth
		await agent.login({
			identifier: TEST_HANDLE,
			password: TEST_PASSWORD,
		});
	});

	describe("createRecord", () => {
		it("creates a post record", async () => {
			const result = await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				record: {
					$type: "app.bsky.feed.post",
					text: "Hello from e2e test!",
					createdAt: new Date().toISOString(),
				},
			});

			expect(result.success).toBe(true);
			expect(result.data.uri).toMatch(/^at:\/\//);
			expect(result.data.cid).toBeDefined();
		});

		it("creates a record with specific rkey", async () => {
			const rkey = uniqueRkey();
			const result = await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Post with specific rkey",
					createdAt: new Date().toISOString(),
				},
			});

			expect(result.success).toBe(true);
			const uri = new AtUri(result.data.uri);
			expect(uri.rkey).toBe(rkey);
		});
	});

	describe("getRecord", () => {
		it("retrieves a created record", async () => {
			const rkey = uniqueRkey();
			const text = `Get test ${rkey}`;

			// Create first
			const createResult = await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text,
					createdAt: new Date().toISOString(),
				},
			});

			// Then get
			const getResult = await agent.com.atproto.repo.getRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
			});

			expect(getResult.success).toBe(true);
			expect((getResult.data.value as { text: string }).text).toBe(text);
			expect(getResult.data.cid).toBe(createResult.data.cid);
		});

		it("returns 404 for non-existent record", async () => {
			await expect(
				agent.com.atproto.repo.getRecord({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey: "non-existent-rkey-12345",
				}),
			).rejects.toThrow();
		});
	});

	describe("listRecords", () => {
		it("lists records in a collection", async () => {
			// Create a few records first
			const rkeys: string[] = [];
			for (let i = 0; i < 3; i++) {
				const rkey = uniqueRkey();
				rkeys.push(rkey);
				await agent.com.atproto.repo.createRecord({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey,
					record: {
						$type: "app.bsky.feed.post",
						text: `List test ${i}`,
						createdAt: new Date().toISOString(),
					},
				});
			}

			const result = await agent.com.atproto.repo.listRecords({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
			});

			expect(result.success).toBe(true);
			expect(result.data.records.length).toBeGreaterThanOrEqual(3);

			// Verify our records are in the list
			const uris = result.data.records.map((r) => new AtUri(r.uri).rkey);
			for (const rkey of rkeys) {
				expect(uris).toContain(rkey);
			}
		});

		it("supports pagination with limit", async () => {
			const result = await agent.com.atproto.repo.listRecords({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				limit: 2,
			});

			expect(result.success).toBe(true);
			expect(result.data.records.length).toBeLessThanOrEqual(2);
		});
	});

	describe("deleteRecord", () => {
		it("deletes an existing record", async () => {
			const rkey = uniqueRkey();

			// Create
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Delete me!",
					createdAt: new Date().toISOString(),
				},
			});

			// Verify exists
			const before = await agent.com.atproto.repo.getRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
			});
			expect(before.success).toBe(true);

			// Delete
			await agent.com.atproto.repo.deleteRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
			});

			// Verify gone
			await expect(
				agent.com.atproto.repo.getRecord({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey,
				}),
			).rejects.toThrow();
		});

		it("no-ops when deleting non-existent record", async () => {
			// Should not throw
			await agent.com.atproto.repo.deleteRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey: "non-existent-rkey-67890",
			});
		});
	});

	describe("putRecord", () => {
		it("creates a new record if it doesn't exist", async () => {
			const rkey = uniqueRkey();

			const result = await agent.com.atproto.repo.putRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Created via putRecord",
					createdAt: new Date().toISOString(),
				},
			});

			expect(result.success).toBe(true);
			expect(result.data.uri).toContain(rkey);
		});

		it("updates an existing record", async () => {
			const rkey = uniqueRkey();

			// Create
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Original text",
					createdAt: new Date().toISOString(),
				},
			});

			// Update via putRecord
			await agent.com.atproto.repo.putRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Updated text",
					createdAt: new Date().toISOString(),
				},
			});

			// Verify update
			const result = await agent.com.atproto.repo.getRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
			});
			expect((result.data.value as { text: string }).text).toBe("Updated text");
		});
	});

	describe("applyWrites", () => {
		it("applies multiple operations atomically", async () => {
			const rkey1 = uniqueRkey();
			const rkey2 = uniqueRkey();

			const result = await agent.com.atproto.repo.applyWrites({
				repo: TEST_DID,
				writes: [
					{
						$type: "com.atproto.repo.applyWrites#create",
						collection: "app.bsky.feed.post",
						rkey: rkey1,
						value: {
							$type: "app.bsky.feed.post",
							text: "First post",
							createdAt: new Date().toISOString(),
						},
					},
					{
						$type: "com.atproto.repo.applyWrites#create",
						collection: "app.bsky.feed.post",
						rkey: rkey2,
						value: {
							$type: "app.bsky.feed.post",
							text: "Second post",
							createdAt: new Date().toISOString(),
						},
					},
				],
			});

			expect(result.success).toBe(true);

			// Verify both exist
			const [get1, get2] = await Promise.all([
				agent.com.atproto.repo.getRecord({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey: rkey1,
				}),
				agent.com.atproto.repo.getRecord({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey: rkey2,
				}),
			]);

			expect(get1.success).toBe(true);
			expect(get2.success).toBe(true);
		});
	});
});
