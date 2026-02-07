import { describe, it, expect } from "vitest";
import { env, worker, runInDurableObject } from "./helpers";
import { asCid, isBlobRef } from "@atproto/lex-data";
import type { AccountDurableObject } from "../src/account-do";

describe("Blob Reference Normalization", () => {
	it("should normalize JSON blob refs to CID objects in stored records", async () => {
		// Step 1: Upload a blob to get a real CID
		const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

		const uploadResponse = await worker.fetch(
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
		expect(uploadResponse.status).toBe(200);

		const uploadData = (await uploadResponse.json()) as {
			blob: {
				$type: string;
				ref: { $link: string };
				mimeType: string;
				size: number;
			};
		};
		const blobCid = uploadData.blob.ref.$link;

		// Step 2: Create a record with the blob ref in JSON wire format
		// This is exactly what clients send — { "$link": "bafk..." } objects,
		// not actual CID instances
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
					rkey: "blob-ref-test",
					record: {
						$type: "app.bsky.feed.post",
						text: "Test post with image",
						createdAt: new Date().toISOString(),
						embed: {
							$type: "app.bsky.embed.images",
							images: [
								{
									alt: "test image",
									image: {
										$type: "blob",
										ref: { $link: blobCid },
										mimeType: "image/png",
										size: pngHeader.length,
									},
								},
							],
						},
					},
				}),
			}),
			env,
		);
		expect(createResponse.status).toBe(200);

		// Step 3: Read it back via the API — should round-trip correctly
		const getResponse = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.repo.getRecord?repo=${env.DID}&collection=app.bsky.feed.post&rkey=blob-ref-test`,
			),
			env,
		);
		expect(getResponse.status).toBe(200);

		const getData = (await getResponse.json()) as {
			value: {
				embed: {
					images: Array<{
						image: {
							$type: string;
							ref: { $link: string };
							mimeType: string;
							size: number;
						};
					}>;
				};
			};
		};

		// The API response should have the blob ref serialized back to JSON format
		const apiImage = getData.value.embed.images[0]!.image;
		expect(apiImage.ref.$link).toBe(blobCid);
		expect(apiImage.mimeType).toBe("image/png");

		// Step 4: Inspect the raw stored record via the repo directly
		// This verifies the internal representation uses CID objects, not JSON
		const id = env.ACCOUNT.idFromName("account");
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			const rawRecord = (await repo.getRecord(
				"app.bsky.feed.post",
				"blob-ref-test",
			)) as any;

			expect(rawRecord).toBeDefined();

			// The raw record should have a BlobRef with a real CID object,
			// not a plain { $link: "..." } JSON object
			const rawImage = rawRecord.embed.images[0].image;

			// isBlobRef checks for a proper BlobRef instance (with CID ref)
			expect(isBlobRef(rawImage)).toBe(true);

			// The ref should be a CID object, not a plain { $link: "..." } object
			const cid = asCid(rawImage.ref);
			expect(cid).not.toBeNull();
			expect(cid!.toString()).toBe(blobCid);
		});
	});

	it("should normalize blob refs in putRecord (upsert)", async () => {
		// Upload a blob
		const testData = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]);
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
		const uploadData = (await uploadResponse.json()) as {
			blob: { ref: { $link: string }; mimeType: string; size: number };
		};
		const blobCid = uploadData.blob.ref.$link;

		// Use putRecord (upsert) with a blob ref
		const putResponse = await worker.fetch(
			new Request("http://pds.test/xrpc/com.atproto.repo.putRecord", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.AUTH_TOKEN}`,
				},
				body: JSON.stringify({
					repo: env.DID,
					collection: "app.bsky.feed.post",
					rkey: "blob-ref-put-test",
					record: {
						$type: "app.bsky.feed.post",
						text: "Put record with image",
						createdAt: new Date().toISOString(),
						embed: {
							$type: "app.bsky.embed.images",
							images: [
								{
									alt: "test",
									image: {
										$type: "blob",
										ref: { $link: blobCid },
										mimeType: "image/jpeg",
										size: testData.length,
									},
								},
							],
						},
					},
				}),
			}),
			env,
		);
		expect(putResponse.status).toBe(200);

		// Verify via raw repo access
		const id = env.ACCOUNT.idFromName("account");
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			const rawRecord = (await repo.getRecord(
				"app.bsky.feed.post",
				"blob-ref-put-test",
			)) as any;

			const rawImage = rawRecord.embed.images[0].image;
			expect(isBlobRef(rawImage)).toBe(true);
			expect(asCid(rawImage.ref)!.toString()).toBe(blobCid);
		});
	});

	it("should normalize blob refs in applyWrites batch", async () => {
		// Upload a blob
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
		const uploadData = (await uploadResponse.json()) as {
			blob: { ref: { $link: string }; mimeType: string; size: number };
		};
		const blobCid = uploadData.blob.ref.$link;

		// Use applyWrites with a blob ref
		const applyResponse = await worker.fetch(
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
							rkey: "blob-ref-batch-test",
							value: {
								$type: "app.bsky.feed.post",
								text: "Batch write with image",
								createdAt: new Date().toISOString(),
								embed: {
									$type: "app.bsky.embed.images",
									images: [
										{
											alt: "batch test",
											image: {
												$type: "blob",
												ref: { $link: blobCid },
												mimeType: "image/png",
												size: testData.length,
											},
										},
									],
								},
							},
						},
					],
				}),
			}),
			env,
		);
		expect(applyResponse.status).toBe(200);

		// Verify via raw repo access
		const id = env.ACCOUNT.idFromName("account");
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			const rawRecord = (await repo.getRecord(
				"app.bsky.feed.post",
				"blob-ref-batch-test",
			)) as any;

			const rawImage = rawRecord.embed.images[0].image;
			expect(isBlobRef(rawImage)).toBe(true);
			expect(asCid(rawImage.ref)!.toString()).toBe(blobCid);
		});
	});
});
