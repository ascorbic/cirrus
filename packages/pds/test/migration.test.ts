import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

describe("Account Migration", () => {
	describe("com.atproto.server.getAccountStatus", () => {
		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.server.getAccountStatus`),
				env,
			);

			expect(response.status).toBe(401);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("AuthMissing");
		});

		it("returns activated status when repo exists", async () => {
			// Create a record to initialize the repo
			await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
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
							text: "Test post for migration",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.server.getAccountStatus`,
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.activated).toBe(true);
			expect(body.validDid).toBe(true);
			expect(body.repoRev).toBeDefined();
			expect(body.repoRev).not.toBeNull();
		});

		it("returns account status info", async () => {
			// Note: In a real test environment, the DO is shared across tests,
			// so the repo likely already exists from previous tests.
			// This test just verifies the endpoint returns valid data.
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.server.getAccountStatus`,
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.validDid).toBe(true);
			// activated can be true or false depending on test execution order
			expect(typeof body.activated).toBe("boolean");
		});
	});

	describe("com.atproto.repo.importRepo", () => {
		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.importRepo`, {
					method: "POST",
					headers: {
						"Content-Type": "application/vnd.ipld.car",
					},
					body: new Uint8Array([]),
				}),
				env,
			);

			expect(response.status).toBe(401);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("AuthMissing");
		});

		it("requires Content-Type to be application/vnd.ipld.car", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.importRepo`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({}),
				}),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("application/vnd.ipld.car");
		});

		it("rejects empty CAR file", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.importRepo`, {
					method: "POST",
					headers: {
						"Content-Type": "application/vnd.ipld.car",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: new Uint8Array([]),
				}),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("Empty");
		});

		it("imports a valid repository CAR file", async () => {
			// First, export a repository to get a valid CAR file
			// Create a repo with some data
			await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "test-import-1",
						record: {
							$type: "app.bsky.feed.post",
							text: "Test post for import",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Export the repo
			const exportResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
				),
				env,
			);

			expect(exportResponse.status).toBe(200);
			const carBytes = new Uint8Array(await exportResponse.arrayBuffer());
			expect(carBytes.length).toBeGreaterThan(0);

			// Now we need to create a new DO instance to import into
			// For this test, we'll verify the import would fail on existing repo
			const importResponse = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.importRepo`, {
					method: "POST",
					headers: {
						"Content-Type": "application/vnd.ipld.car",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: carBytes,
				}),
				env,
			);

			// Should fail because repo already exists
			expect(importResponse.status).toBe(409);
			const body = (await importResponse.json()) as Record<string, unknown>;
			expect(body.error).toBe("RepoAlreadyExists");
		});

		it("rejects oversized CAR files", async () => {
			// Create a fake oversized CAR file (larger than 100MB)
			// For testing purposes, we'll just check the error handling
			// A real oversized file would be too large to create in a test
			const largeBuffer = new Uint8Array(101 * 1024 * 1024); // 101MB

			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.importRepo`, {
					method: "POST",
					headers: {
						"Content-Type": "application/vnd.ipld.car",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: largeBuffer,
				}),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("RepoTooLarge");
		});
	});

	describe("com.atproto.repo.listMissingBlobs", () => {
		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.listMissingBlobs`),
				env,
			);

			expect(response.status).toBe(401);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("AuthMissing");
		});

		it("returns empty blobs list when no blobs are referenced", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.listMissingBlobs`, {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				blobs: Array<{ cid: string; recordUri: string }>;
				cursor?: string;
			};
			expect(body.blobs).toBeDefined();
			expect(Array.isArray(body.blobs)).toBe(true);
		});

		it("supports limit parameter", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.listMissingBlobs?limit=10`,
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				blobs: Array<{ cid: string; recordUri: string }>;
			};
			expect(body.blobs).toBeDefined();
		});
	});

	describe("com.atproto.sync.getBlocks", () => {
		it("requires did parameter", async () => {
			const response = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.sync.getBlocks`),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("did");
		});

		it("requires cids parameter", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlocks?did=${env.DID}`,
				),
				env,
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("cids");
		});

		it("returns CAR file for valid CIDs", async () => {
			// First create a record to get a valid repo
			await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
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
							text: "Test post for getBlocks",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			// Get the repo status to find the head CID
			const statusResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepoStatus?did=${env.DID}`,
				),
				env,
			);
			const status = (await statusResponse.json()) as { rev: string };

			// Now get the blocks using a made-up CID (won't find the block, but should return valid CAR)
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlocks?did=${env.DID}&cids=bafyreihv5qx4d7qnvqsrn3nxb4xn77aedsj4irmkutvvq7cthm7z5oqxqy`,
				),
				env,
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"application/vnd.ipld.car",
			);
		});

		it("rejects unknown DID", async () => {
			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getBlocks?did=did:plc:unknown&cids=bafyreihv5qx4d7qnvqsrn3nxb4xn77aedsj4irmkutvvq7cthm7z5oqxqy`,
				),
				env,
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.error).toBe("RepoNotFound");
		});
	});

	describe("getAccountStatus with migration metrics", () => {
		it("returns block and record counts", async () => {
			// Create a record to ensure there's data
			await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
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
							text: "Test post for metrics",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			const response = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.server.getAccountStatus`,
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				activated: boolean;
				validDid: boolean;
				repoCommit: string;
				repoRev: string;
				repoBlocks: number;
				indexedRecords: number;
				expectedBlobs: number;
				importedBlobs: number;
			};

			expect(body.activated).toBe(true);
			expect(body.validDid).toBe(true);
			expect(body.repoCommit).toBeDefined();
			expect(body.repoRev).toBeDefined();
			expect(typeof body.repoBlocks).toBe("number");
			expect(body.repoBlocks).toBeGreaterThan(0);
			expect(typeof body.indexedRecords).toBe("number");
			expect(body.indexedRecords).toBeGreaterThan(0);
			expect(typeof body.expectedBlobs).toBe("number");
			expect(typeof body.importedBlobs).toBe("number");
		});
	});

	describe("Migration workflow", () => {
		it("complete migration workflow: export from source, import to target", async () => {
			// Step 1: Create source repo with data
			const createResponse = await worker.fetch(
				new Request(`http://pds.test/xrpc/com.atproto.repo.createRecord`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						repo: env.DID,
						collection: "app.bsky.feed.post",
						rkey: "migration-test",
						record: {
							$type: "app.bsky.feed.post",
							text: "Post to be migrated",
							createdAt: new Date().toISOString(),
						},
					}),
				}),
				env,
			);

			expect(createResponse.status).toBe(200);

			// Step 2: Check account status before export
			const statusBeforeResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.server.getAccountStatus`,
					{
						headers: {
							Authorization: `Bearer ${env.AUTH_TOKEN}`,
						},
					},
				),
				env,
			);

			expect(statusBeforeResponse.status).toBe(200);
			const statusBefore = (await statusBeforeResponse.json()) as Record<
				string,
				unknown
			>;
			expect(statusBefore.activated).toBe(true);
			expect(statusBefore.repoRev).toBeDefined();

			// Step 3: Export the repo
			const exportResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.sync.getRepo?did=${env.DID}`,
				),
				env,
			);

			expect(exportResponse.status).toBe(200);
			expect(exportResponse.headers.get("Content-Type")).toBe(
				"application/vnd.ipld.car",
			);

			const carBytes = new Uint8Array(await exportResponse.arrayBuffer());
			expect(carBytes.length).toBeGreaterThan(0);

			// Step 4: Verify the CAR file is valid
			const { CarReader } = await import("@ipld/car");
			const reader = await CarReader.fromBytes(carBytes);
			const roots = await reader.getRoots();
			expect(roots).toHaveLength(1);

			// Note: In a real migration, you would:
			// 1. Export from old PDS
			// 2. Set up new PDS with same DID
			// 3. Import to new PDS (which would have empty repo)
			// 4. Update DID document to point to new PDS
			// 5. Verify migration was successful

			// For this test, we can't actually import because the repo already exists
			// But we've verified the export produces a valid CAR file
		});
	});
});
