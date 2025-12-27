import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";

describe("Blob Storage", () => {
	describe("uploadBlob", () => {
		it("should upload a blob and return BlobRef", async () => {
			// Create a simple PNG header
			const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "image/png",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: pngHeader,
				}),
				env,
			);

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toMatchObject({
				blob: {
					$type: "blob",
					ref: {
						$link: expect.any(String),
					},
					mimeType: "image/png",
					size: pngHeader.length,
				},
			});
		});

		it("should reject blob larger than 5MB", async () => {
			// Create a blob larger than 5MB
			const largeBlob = new Uint8Array(6 * 1024 * 1024); // 6MB

			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "application/octet-stream",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: largeBlob,
				}),
				env,
			);

			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "BlobTooLarge",
			});
		});

		it("should require authentication", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);

			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "application/octet-stream",
					},
					body: bytes,
				}),
				env,
			);

			expect(response.status).toBe(401);
		});

		it("should use default content type for missing header", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);

			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: bytes,
				}),
				env,
			);

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.blob.mimeType).toBe("application/octet-stream");
		});
	});

	describe("getBlob", () => {
		it("should retrieve uploaded blob", async () => {
			// First upload a blob
			const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			const uploadResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "application/octet-stream",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: testData,
				}),
				env,
			);

			expect(uploadResponse.status).toBe(200);

			const uploadData = await uploadResponse.json();
			const cid = uploadData.blob.ref.$link;

			// Then retrieve it
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${cid}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe(
				"application/octet-stream",
			);

			const retrievedData = new Uint8Array(await getResponse.arrayBuffer());
			expect(retrievedData).toEqual(testData);
		});

		it("should return 404 for nonexistent blob", async () => {
			// Use a fake CID
			const fakeCid =
				"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${fakeCid}`,
				),
				env,
			);

			expect(response.status).toBe(404);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "BlobNotFound",
			});
		});

		it("should return 404 for wrong DID", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=did:web:other.com&cid=bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`,
				),
				env,
			);

			expect(response.status).toBe(404);

			const data = await response.json();
			expect(data).toMatchObject({
				error: "RepoNotFound",
			});
		});

		it("should require both did and cid parameters", async () => {
			const response1 = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}`),
				env,
			);

			expect(response1.status).toBe(400);

			const response2 = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?cid=bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`,
				),
				env,
			);

			expect(response2.status).toBe(400);
		});

		it("should preserve content type", async () => {
			// Upload a blob with specific content type
			const testData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const uploadResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "image/png",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: testData,
				}),
				env,
			);

			const uploadData = await uploadResponse.json();
			const cid = uploadData.blob.ref.$link;

			// Retrieve and check content type
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${cid}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe("image/png");
		});
	});

	describe("Integration", () => {
		it("should handle upload and retrieval flow", async () => {
			// Create test data
			const testData = new Uint8Array([
				255, 216, 255, 224, 0, 16, 74, 70, 73, 70,
			]); // JPEG header

			// Upload
			const uploadResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
					method: "POST",
					headers: {
						"Content-Type": "image/jpeg",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: testData,
				}),
				env,
			);

			expect(uploadResponse.status).toBe(200);

			const { blob } = await uploadResponse.json();
			expect(blob.$type).toBe("blob");
			expect(blob.ref.$link).toBeTruthy();
			expect(blob.mimeType).toBe("image/jpeg");
			expect(blob.size).toBe(testData.length);

			// Retrieve
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);

			const retrievedData = new Uint8Array(await getResponse.arrayBuffer());
			expect(retrievedData).toEqual(testData);
			expect(getResponse.headers.get("Content-Type")).toBe("image/jpeg");
			expect(getResponse.headers.get("Content-Length")).toBe(
				testData.length.toString(),
			);
		});
	});
});
