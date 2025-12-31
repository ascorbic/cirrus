import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import { CarReader } from "@ipld/car";
import { createAgent, getBaseUrl, TEST_DID, TEST_HANDLE, TEST_PASSWORD, uniqueRkey } from "./helpers";

describe("CAR Export", () => {
	let agent: AtpAgent;

	beforeAll(async () => {
		agent = createAgent();
		await agent.login({
			identifier: TEST_HANDLE,
			password: TEST_PASSWORD,
		});

		// Ensure repo has some data
		await agent.com.atproto.repo.createRecord({
			repo: TEST_DID,
			collection: "app.bsky.feed.post",
			rkey: uniqueRkey(),
			record: {
				$type: "app.bsky.feed.post",
				text: "Export test post",
				createdAt: new Date().toISOString(),
			},
		});
	});

	describe("getRepo", () => {
		it("exports repository as valid CAR file", async () => {
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getRepo?did=${TEST_DID}`,
			);

			expect(response.ok).toBe(true);
			expect(response.headers.get("Content-Type")).toBe(
				"application/vnd.ipld.car",
			);

			const carBytes = new Uint8Array(await response.arrayBuffer());
			expect(carBytes.length).toBeGreaterThan(0);

			// Parse as CAR file
			const reader = await CarReader.fromBytes(carBytes);

			const roots = await reader.getRoots();
			expect(roots).toHaveLength(1);
			// Root CID should be a valid CID string
			expect(roots[0].toString()).toMatch(/^bafy/);

			// Verify root block exists
			const rootBlock = await reader.get(roots[0]);
			expect(rootBlock).toBeDefined();
		});

		it("CAR contains repository blocks", async () => {
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getRepo?did=${TEST_DID}`,
			);

			const carBytes = new Uint8Array(await response.arrayBuffer());
			const reader = await CarReader.fromBytes(carBytes);

			const blocks: Array<{ cid: unknown; bytes: Uint8Array }> = [];
			for await (const block of reader.blocks()) {
				blocks.push(block);
			}

			// Should have multiple blocks (commit + MST nodes + records)
			expect(blocks.length).toBeGreaterThan(1);
		});

		it("returns 404 for non-existent DID", async () => {
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getRepo?did=did:web:nonexistent.example`,
			);

			expect(response.ok).toBe(false);
		});
	});

	describe.skip("getLatestCommit", () => {
		// TODO: Implement com.atproto.sync.getLatestCommit endpoint
		it("returns latest commit info", async () => {
			const result = await agent.com.atproto.sync.getLatestCommit({
				did: TEST_DID,
			});

			expect(result.success).toBe(true);
			expect(result.data.cid).toBeDefined();
			expect(result.data.rev).toBeDefined();
			// CID should be valid
			expect(result.data.cid).toMatch(/^bafy/);
		});

		it("commit changes after write", async () => {
			const before = await agent.com.atproto.sync.getLatestCommit({
				did: TEST_DID,
			});

			// Make a write
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey: uniqueRkey(),
				record: {
					$type: "app.bsky.feed.post",
					text: "Commit test post",
					createdAt: new Date().toISOString(),
				},
			});

			const after = await agent.com.atproto.sync.getLatestCommit({
				did: TEST_DID,
			});

			// Commit CID and rev should be different
			expect(after.data.cid).not.toBe(before.data.cid);
			expect(after.data.rev).not.toBe(before.data.rev);
		});
	});

	describe("describeRepo", () => {
		it("returns repo description", async () => {
			const result = await agent.com.atproto.repo.describeRepo({
				repo: TEST_DID,
			});

			expect(result.success).toBe(true);
			expect(result.data.did).toBe(TEST_DID);
			expect(result.data.handle).toBe(TEST_HANDLE);
			expect(result.data.collections).toBeDefined();
			expect(Array.isArray(result.data.collections)).toBe(true);
			// Should include the post collection
			expect(result.data.collections).toContain("app.bsky.feed.post");
		});
	});
});
