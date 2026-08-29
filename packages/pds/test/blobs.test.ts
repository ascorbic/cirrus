import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";
import { extractJsonBlobCids } from "../src/blobs";

/**
 * Reference a blob from a record so it gets promoted from staging to its
 * public serving key. Uses an unknown collection (validation is optimistic
 * for unloaded lexicons) so the record shape doesn't matter.
 */
async function referenceBlob(blob: unknown): Promise<void> {
	const res = await worker.fetch(
		new Request("http://pds.test/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.AUTH_TOKEN}`,
			},
			body: JSON.stringify({
				repo: env.DID,
				collection: "test.cirrus.blobRef",
				record: { $type: "test.cirrus.blobRef", file: blob },
			}),
		}),
		env,
	);
	expect(res.status).toBe(200);
}

async function uploadBlob(
	bytes: Uint8Array,
	contentType: string,
): Promise<{
	$type: string;
	ref: { $link: string };
	mimeType: string;
	size: number;
}> {
	const response = await worker.fetch(
		new Request("http://pds.test/xrpc/com.atproto.repo.uploadBlob", {
			method: "POST",
			headers: {
				"Content-Type": contentType,
				Authorization: `Bearer ${env.AUTH_TOKEN}`,
			},
			body: bytes,
		}),
		env,
	);
	expect(response.status).toBe(200);
	const data = (await response.json()) as {
		blob: {
			$type: string;
			ref: { $link: string };
			mimeType: string;
			size: number;
		};
	};
	return data.blob;
}

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

		it("should reject blob larger than 60MB", async () => {
			// Create a blob larger than 60MB
			const largeBlob = new Uint8Array(61 * 1024 * 1024); // 61MB

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

			const data = (await response.json()) as { blob: { mimeType: string } };
			expect(data.blob.mimeType).toBe("application/octet-stream");
		});
	});

	describe("getBlob", () => {
		it("should retrieve uploaded blob once referenced", async () => {
			const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			const blob = await uploadBlob(testData, "application/octet-stream");
			await referenceBlob(blob);

			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
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
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}`,
				),
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
			const testData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const blob = await uploadBlob(testData, "image/png");
			await referenceBlob(blob);

			// Retrieve and check content type
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe("image/png");
		});
	});

	describe("Content-Type Detection", () => {
		it("should detect video/mp4 from magic bytes when stored with */*", async () => {
			// Create a valid MP4 header (ftyp box with isom brand)
			const mp4Header = new Uint8Array([
				0x00,
				0x00,
				0x00,
				0x14, // box size (20 bytes)
				0x66,
				0x74,
				0x79,
				0x70, // "ftyp"
				0x69,
				0x73,
				0x6f,
				0x6d, // "isom" brand
				0x00,
				0x00,
				0x00,
				0x01, // minor version
				0x69,
				0x73,
				0x6f,
				0x6d, // compatible brand
			]);

			// Upload with wildcard content type (simulating the bug)
			const blob = await uploadBlob(mp4Header, "*/*");
			await referenceBlob(blob);

			// Retrieve - should detect video/mp4 from magic bytes
			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe("video/mp4");
		});

		it("should detect image/jpeg from magic bytes when stored with */*", async () => {
			// JPEG magic bytes
			const jpegData = new Uint8Array([
				0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
			]);

			const blob = await uploadBlob(jpegData, "*/*");
			await referenceBlob(blob);

			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe("image/jpeg");
		});

		it("should detect image/png from magic bytes", async () => {
			// PNG magic bytes
			const pngData = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			]);

			const blob = await uploadBlob(pngData, "*/*");
			await referenceBlob(blob);

			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe("image/png");
		});

		it("should fallback to application/octet-stream for unknown content", async () => {
			// Random bytes that don't match any known format
			const unknownData = new Uint8Array([
				0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
			]);

			const blob = await uploadBlob(unknownData, "*/*");
			await referenceBlob(blob);

			const getResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);

			expect(getResponse.status).toBe(200);
			expect(getResponse.headers.get("Content-Type")).toBe(
				"application/octet-stream",
			);
		});
	});

	describe("Integration", () => {
		it("should handle upload, reference and retrieval flow", async () => {
			// Create test data
			const testData = new Uint8Array([
				255, 216, 255, 224, 0, 16, 74, 70, 73, 70,
			]); // JPEG header

			const blob = await uploadBlob(testData, "image/jpeg");
			expect(blob.$type).toBe("blob");
			expect(blob.ref.$link).toBeTruthy();
			expect(blob.mimeType).toBe("image/jpeg");
			expect(blob.size).toBe(testData.length);

			await referenceBlob(blob);

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

	describe("Blob staging", () => {
		it("does not serve an uploaded blob until a record references it", async () => {
			const bytes = new Uint8Array([0x53, 0x54, 0x41, 0x47, 0x45, 0x44, 0x21]);
			const blob = await uploadBlob(bytes, "application/octet-stream");

			// Not fetchable while staged
			const before = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);
			expect(before.status).toBe(404);

			await referenceBlob(blob);

			// Promoted and fetchable after the record write
			const after = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);
			expect(after.status).toBe(200);
			expect(new Uint8Array(await after.arrayBuffer())).toEqual(bytes);
		});

		it("promotes blobs referenced via putRecord", async () => {
			const bytes = new Uint8Array([0x50, 0x55, 0x54, 0x52, 0x45, 0x43]);
			const blob = await uploadBlob(bytes, "application/octet-stream");

			const res = await worker.fetch(
				new Request("http://pds.test/xrpc/com.atproto.repo.putRecord", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "test.cirrus.blobRef",
						rkey: "putrecord-blob",
						record: { $type: "test.cirrus.blobRef", file: blob },
					}),
				}),
				env,
			);
			expect(res.status).toBe(200);

			const get = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);
			expect(get.status).toBe(200);
		});

		it("promotes blobs referenced via applyWrites", async () => {
			const bytes = new Uint8Array([0x41, 0x50, 0x50, 0x4c, 0x59, 0x57]);
			const blob = await uploadBlob(bytes, "application/octet-stream");

			const res = await worker.fetch(
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
								collection: "test.cirrus.blobRef",
								value: { $type: "test.cirrus.blobRef", file: blob },
							},
						],
					}),
				}),
				env,
			);
			expect(res.status).toBe(200);

			const get = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlob?did=${env.DID}&cid=${blob.ref.$link}`,
				),
				env,
			);
			expect(get.status).toBe(200);
		});

		it("excludes staged uploads from listBlobs", async () => {
			const stagedBytes = new Uint8Array([0x4e, 0x4f, 0x4c, 0x49, 0x53, 0x54]);
			const servedBytes = new Uint8Array([0x59, 0x45, 0x53, 0x4c, 0x49, 0x53]);
			const stagedBlob = await uploadBlob(
				stagedBytes,
				"application/octet-stream",
			);
			const servedBlob = await uploadBlob(
				servedBytes,
				"application/octet-stream",
			);
			await referenceBlob(servedBlob);

			const res = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.listBlobs?did=${env.DID}&limit=1000`,
				),
				env,
			);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { cids: string[] };
			expect(data.cids).toContain(servedBlob.ref.$link);
			expect(data.cids).not.toContain(stagedBlob.ref.$link);
		});
	});

	describe("extractJsonBlobCids", () => {
		const ref = (cid: string) => ({
			$type: "blob",
			ref: { $link: cid },
			mimeType: "image/png",
			size: 1,
		});

		it("finds typed blob refs at any depth", () => {
			const record = {
				$type: "app.bsky.feed.post",
				embed: {
					$type: "app.bsky.embed.images",
					images: [
						{ image: ref("bafone"), alt: "" },
						{ image: ref("baftwo"), alt: "" },
					],
				},
			};
			expect(extractJsonBlobCids(record).sort()).toEqual([
				"bafone",
				"baftwo",
			]);
		});

		it("finds legacy untyped blob refs", () => {
			const record = {
				avatar: { cid: "baflegacy", mimeType: "image/jpeg" },
			};
			expect(extractJsonBlobCids(record)).toEqual(["baflegacy"]);
		});

		it("deduplicates repeated refs", () => {
			const record = { a: ref("bafsame"), b: ref("bafsame") };
			expect(extractJsonBlobCids(record)).toEqual(["bafsame"]);
		});

		it("returns nothing for records without blobs", () => {
			expect(
				extractJsonBlobCids({ $type: "app.bsky.feed.post", text: "hi" }),
			).toEqual([]);
		});
	});
});
