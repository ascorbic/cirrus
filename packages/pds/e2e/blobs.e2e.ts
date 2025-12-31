import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import {
	createAgent,
	getBaseUrl,
	TEST_DID,
	TEST_HANDLE,
	TEST_PASSWORD,
	uniqueRkey,
} from "./helpers";

describe("Blob Storage", () => {
	let agent: AtpAgent;

	beforeAll(async () => {
		agent = createAgent();
		await agent.login({
			identifier: TEST_HANDLE,
			password: TEST_PASSWORD,
		});
	});

	describe("uploadBlob", () => {
		it("uploads a blob", async () => {
			// Create a simple test blob (PNG header bytes)
			const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

			const result = await agent.com.atproto.repo.uploadBlob(pngBytes, {
				encoding: "image/png",
			});

			expect(result.success).toBe(true);
			expect(result.data.blob.ref.$link).toBeDefined();
			expect(result.data.blob.mimeType).toBe("image/png");
			expect(result.data.blob.size).toBe(pngBytes.length);
		});

		it("uploads blob and associates with record", async () => {
			const testData = new Uint8Array([1, 2, 3, 4, 5]);

			// Upload blob
			const uploadResult = await agent.com.atproto.repo.uploadBlob(testData, {
				encoding: "application/octet-stream",
			});

			expect(uploadResult.success).toBe(true);
			const blobRef = uploadResult.data.blob;

			// Create a post with the blob embedded
			const rkey = uniqueRkey();
			const postResult = await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Post with blob",
					createdAt: new Date().toISOString(),
					embed: {
						$type: "app.bsky.embed.images",
						images: [
							{
								image: blobRef,
								alt: "Test image",
							},
						],
					},
				},
			});

			expect(postResult.success).toBe(true);

			// Verify blob is retrievable via getBlob
			const cid = blobRef.ref.$link;
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getBlob?did=${TEST_DID}&cid=${cid}`,
			);

			expect(response.ok).toBe(true);
			const retrieved = new Uint8Array(await response.arrayBuffer());
			expect(retrieved).toEqual(testData);
		});
	});

	describe("getBlob", () => {
		it("retrieves an uploaded blob", async () => {
			const testData = new Uint8Array([10, 20, 30, 40, 50]);

			// Upload blob first
			const uploadResult = await agent.com.atproto.repo.uploadBlob(testData, {
				encoding: "application/octet-stream",
			});
			const cid = uploadResult.data.blob.ref.$link;

			// Associate with a record so it's "committed"
			const rkey = uniqueRkey();
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Post for blob retrieval test",
					createdAt: new Date().toISOString(),
					embed: {
						$type: "app.bsky.embed.images",
						images: [
							{
								image: uploadResult.data.blob,
								alt: "Test",
							},
						],
					},
				},
			});

			// Retrieve via HTTP
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getBlob?did=${TEST_DID}&cid=${cid}`,
			);

			expect(response.ok).toBe(true);
			expect(response.headers.get("content-type")).toBe(
				"application/octet-stream",
			);

			const retrieved = new Uint8Array(await response.arrayBuffer());
			expect(retrieved).toEqual(testData);
		});

		it("returns 404 for non-existent blob", async () => {
			const fakeCid =
				"bafyreihwvs4crshs6ldcp73ue3cxrtzglohz6s7ks3dqv4i4t27bvzg2jq";

			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.getBlob?did=${TEST_DID}&cid=${fakeCid}`,
			);

			expect(response.ok).toBe(false);
			expect(response.status).toBe(400); // BlobNotFound returns 400
		});
	});

	describe("listBlobs", () => {
		it("lists blobs for a repo", async () => {
			// Upload a blob and associate it
			const testData = new Uint8Array([100, 101, 102]);
			const uploadResult = await agent.com.atproto.repo.uploadBlob(testData, {
				encoding: "image/png",
			});

			const rkey = uniqueRkey();
			await agent.com.atproto.repo.createRecord({
				repo: TEST_DID,
				collection: "app.bsky.feed.post",
				rkey,
				record: {
					$type: "app.bsky.feed.post",
					text: "Post for listBlobs test",
					createdAt: new Date().toISOString(),
					embed: {
						$type: "app.bsky.embed.images",
						images: [
							{
								image: uploadResult.data.blob,
								alt: "Test",
							},
						],
					},
				},
			});

			// List blobs
			const response = await fetch(
				`${getBaseUrl()}/xrpc/com.atproto.sync.listBlobs?did=${TEST_DID}`,
			);

			expect(response.ok).toBe(true);
			const data = (await response.json()) as { cids: string[] };
			expect(data.cids).toBeDefined();
			expect(Array.isArray(data.cids)).toBe(true);
			// Should contain our uploaded blob
			expect(data.cids).toContain(uploadResult.data.blob.ref.$link);
		});
	});
});
