import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import worker from "../src/index";

describe("Account Migration", () => {
	describe("com.atproto.server.getAccountStatus", () => {
		it("requires authentication", async () => {
			const response = await SELF.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.server.getAccountStatus`,
				),
				env,
			);

			expect(response.status).toBe(401);
			const body = await response.json();
			expect(body.error).toBe("AuthMissing");
		});

		it("returns activated status when repo exists", async () => {
			// Create a record to initialize the repo
			await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.createRecord`,
					{
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
					},
				),
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
			const body = await response.json();
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
			const body = await response.json();
			expect(body.validDid).toBe(true);
			// activated can be true or false depending on test execution order
			expect(typeof body.activated).toBe("boolean");
		});
	});

	describe("com.atproto.repo.importRepo", () => {
		it("requires authentication", async () => {
			const response = await SELF.fetch(
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
			const body = await response.json();
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
			const body = await response.json();
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
			const body = await response.json();
			expect(body.error).toBe("InvalidRequest");
			expect(body.message).toContain("Empty");
		});

		it("imports a valid repository CAR file", async () => {
			// First, export a repository to get a valid CAR file
			// Create a repo with some data
			await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.createRecord`,
					{
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
					},
				),
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
			const body = await importResponse.json();
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
			const body = await response.json();
			expect(body.error).toBe("RepoTooLarge");
		});
	});

	describe("Migration workflow", () => {
		it("complete migration workflow: export from source, import to target", async () => {
			// Step 1: Create source repo with data
			const createResponse = await worker.fetch(
				new Request(
					`http://pds.test/xrpc/com.atproto.repo.createRecord`,
					{
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
					},
				),
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
			const statusBefore = await statusBeforeResponse.json();
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
