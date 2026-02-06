import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import { CarReader } from "@ipld/car";
import { createAgent, getBaseUrl, TEST_DID, TEST_HANDLE, uniqueRkey } from "./helpers";

// TODO: Rewrite tests to use Farcaster Quick Auth (fid.is.auth.login)
// Tests that require authentication are skipped until Farcaster Quick Auth e2e testing is implemented
describe("CAR Export", () => {
	let agent: AtpAgent;

	beforeAll(async () => {
		agent = createAgent();
		// TODO: Implement Farcaster Quick Auth login for e2e tests
	});

	describe("getRepo", () => {
		// getRepo doesn't require auth but needs an existing repo - skip for now
		it.skip("exports repository as valid CAR file", async () => {
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

		it.skip("CAR contains repository blocks", async () => {
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

	describe.skip("describeRepo", () => {
		// Requires existing repo which requires auth to create
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
