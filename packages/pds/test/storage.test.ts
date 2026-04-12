import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "./helpers";
import { CID } from "@atproto/lex-data";
import { encode, cidForCbor, type LexValue } from "@atproto/lex-cbor";
import { BlockMap, CidSet } from "@atproto/repo";
import { AccountDurableObject } from "../src/account-do";
import { SqliteRepoStorage } from "../src/storage";
import { SqliteOAuthStorage } from "../src/oauth-storage";
import { REFRESH_TOKEN_TTL } from "@getcirrus/oauth-provider";

// Helper to create a CID from data
async function createCid(
	data: LexValue,
): Promise<{ cid: CID; bytes: Uint8Array }> {
	const bytes = encode(data);
	const cid = await cidForCbor(bytes);
	return { cid, bytes };
}

describe("SqliteRepoStorage", () => {
	describe("basic operations", () => {
		it("stores and retrieves blocks", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const { cid, bytes } = await createCid({ hello: "world" });

				await storage.putBlock(cid, bytes, "rev1");
				const retrieved = await storage.getBytes(cid);

				expect(retrieved).not.toBeNull();
				expect(new Uint8Array(retrieved!)).toEqual(bytes);
			});
		});

		it("returns null for non-existent blocks", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const { cid } = await createCid({ nonexistent: true });
				const retrieved = await storage.getBytes(cid);

				expect(retrieved).toBeNull();
			});
		});

		it("checks block existence with has()", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const { cid, bytes } = await createCid({ test: "data" });

				expect(await storage.has(cid)).toBe(false);

				await storage.putBlock(cid, bytes, "rev1");

				expect(await storage.has(cid)).toBe(true);
			});
		});

		it("stores multiple blocks with putMany()", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const blocks = new BlockMap();
				const block1 = await createCid({ block: 1 });
				const block2 = await createCid({ block: 2 });
				const block3 = await createCid({ block: 3 });

				blocks.set(block1.cid, block1.bytes);
				blocks.set(block2.cid, block2.bytes);
				blocks.set(block3.cid, block3.bytes);

				await storage.putMany(blocks, "rev1");

				expect(await storage.has(block1.cid)).toBe(true);
				expect(await storage.has(block2.cid)).toBe(true);
				expect(await storage.has(block3.cid)).toBe(true);
				expect(await storage.countBlocks()).toBe(3);
			});
		});

		it("retrieves multiple blocks with getBlocks()", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const block1 = await createCid({ block: 1 });
				const block2 = await createCid({ block: 2 });
				const nonexistent = await createCid({ nonexistent: true });

				await storage.putBlock(block1.cid, block1.bytes, "rev1");
				await storage.putBlock(block2.cid, block2.bytes, "rev1");

				const result = await storage.getBlocks([
					block1.cid,
					block2.cid,
					nonexistent.cid,
				]);

				expect(result.blocks.has(block1.cid)).toBe(true);
				expect(result.blocks.has(block2.cid)).toBe(true);
				expect(result.missing).toHaveLength(1);
				expect(result.missing[0]?.toString()).toBe(nonexistent.cid.toString());
			});
		});
	});

	describe("root and revision management", () => {
		it("starts with null root", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				expect(await storage.getRoot()).toBeNull();
				expect(await storage.getRev()).toBeNull();
			});
		});

		it("updates root and revision", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const { cid, bytes } = await createCid({ root: "commit1" });
				await storage.putBlock(cid, bytes, "rev1");
				await storage.updateRoot(cid, "rev1");

				const root = await storage.getRoot();
				expect(root).not.toBeNull();
				expect(root!.toString()).toBe(cid.toString());
				expect(await storage.getRev()).toBe("rev1");
			});
		});
	});



	describe("applyCommit", () => {
		it("applies a commit with new blocks", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const commitBlock = await createCid({ type: "commit", data: "test" });
				const dataBlock = await createCid({ record: "data" });

				const newBlocks = new BlockMap();
				newBlocks.set(commitBlock.cid, commitBlock.bytes);
				newBlocks.set(dataBlock.cid, dataBlock.bytes);

				await storage.applyCommit({
					cid: commitBlock.cid,
					rev: "rev1",
					since: null,
					prev: null,
					newBlocks,
					relevantBlocks: new BlockMap(),
					removedCids: new CidSet(),
				});

				expect(await storage.has(commitBlock.cid)).toBe(true);
				expect(await storage.has(dataBlock.cid)).toBe(true);
				expect((await storage.getRoot())?.toString()).toBe(
					commitBlock.cid.toString(),
				);
				expect(await storage.getRev()).toBe("rev1");
			});
		});

		it("removes old blocks when applying commit", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				// Initial commit
				const oldBlock = await createCid({ old: "data" });
				const initialCommit = await createCid({ type: "commit", rev: 1 });

				const initialBlocks = new BlockMap();
				initialBlocks.set(oldBlock.cid, oldBlock.bytes);
				initialBlocks.set(initialCommit.cid, initialCommit.bytes);

				await storage.applyCommit({
					cid: initialCommit.cid,
					rev: "rev1",
					since: null,
					prev: null,
					newBlocks: initialBlocks,
					relevantBlocks: new BlockMap(),
					removedCids: new CidSet(),
				});

				expect(await storage.has(oldBlock.cid)).toBe(true);

				// New commit that removes the old block
				const newBlock = await createCid({ new: "data" });
				const newCommit = await createCid({ type: "commit", rev: 2 });

				const newBlocks = new BlockMap();
				newBlocks.set(newBlock.cid, newBlock.bytes);
				newBlocks.set(newCommit.cid, newCommit.bytes);

				const removedCids = new CidSet();
				removedCids.add(oldBlock.cid);

				await storage.applyCommit({
					cid: newCommit.cid,
					rev: "rev2",
					since: "rev1",
					prev: initialCommit.cid,
					newBlocks,
					relevantBlocks: new BlockMap(),
					removedCids,
				});

				// Old block should be removed
				expect(await storage.has(oldBlock.cid)).toBe(false);
				// New blocks should exist
				expect(await storage.has(newBlock.cid)).toBe(true);
				expect(await storage.has(newCommit.cid)).toBe(true);
				// Root should be updated
				expect((await storage.getRoot())?.toString()).toBe(
					newCommit.cid.toString(),
				);
				expect(await storage.getRev()).toBe("rev2");
			});
		});
	});

	describe("utility methods", () => {
		it("calculates storage size", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				expect(await storage.sizeInBytes()).toBe(0);

				const { cid, bytes } = await createCid({ some: "data" });
				await storage.putBlock(cid, bytes, "rev1");

				expect(await storage.sizeInBytes()).toBe(bytes.length);
			});
		});

		it("destroys all data", async () => {
			const id = env.ACCOUNT.newUniqueId();
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				const storage = await instance.getStorage();

				const { cid, bytes } = await createCid({ data: "test" });
				await storage.putBlock(cid, bytes, "rev1");
				await storage.updateRoot(cid, "rev1");

				expect(await storage.has(cid)).toBe(true);
				expect(await storage.getRoot()).not.toBeNull();

				await storage.destroy();

				expect(await storage.has(cid)).toBe(false);
				expect(await storage.getRoot()).toBeNull();
			});
		});
	});
});

describe("AccountDurableObject", () => {
	it("initializes storage on first access", async () => {
		const id = env.ACCOUNT.newUniqueId();
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const storage = await instance.getStorage();
			expect(storage).toBeInstanceOf(SqliteRepoStorage);
		});
	});

	it("creates a new repo on first access", async () => {
		const id = env.ACCOUNT.newUniqueId();
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			expect(repo).toBeDefined();
			expect(repo.did).toBe(env.DID);
			expect(repo.cid).toBeDefined();
		});
	});

	it("loads existing repo from storage", async () => {
		const id = env.ACCOUNT.idFromName("persistent-test");
		const stub = env.ACCOUNT.get(id);

		let firstRepoCid: string;

		// First access - create repo
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			firstRepoCid = repo.cid.toString();
			expect(repo.did).toBe(env.DID);
		});

		// Second access to same DO - should load existing repo
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const repo = await instance.getRepo();
			expect(repo.cid.toString()).toBe(firstRepoCid);
			expect(repo.did).toBe(env.DID);
		});
	});
});


describe("SqliteOAuthStorage", () => {
	it("preserves refresh-valid tokens when access token has expired", async () => {
		const id = env.ACCOUNT.newUniqueId();
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const oauthStorage = await instance.getOAuthStorage();
			const now = Date.now();
			const tokenData = {
				accessToken: "expired-access-token",
				refreshToken: "still-valid-refresh-token",
				clientId: "did:web:app.example",
				sub: env.DID,
				scope: "atproto",
				issuedAt: now - 2 * 60 * 60 * 1000,
				accessExpiresAt: now - 60 * 1000,
				refreshExpiresAt: now + 24 * 60 * 60 * 1000,
				revoked: false,
			};

			await oauthStorage.saveTokens(tokenData);
			oauthStorage.cleanup();

			const tokenByRefresh = await oauthStorage.getTokenByRefresh(
				tokenData.refreshToken,
			);
			expect(tokenByRefresh).not.toBeNull();
			expect(tokenByRefresh?.refreshToken).toBe(tokenData.refreshToken);
			expect(await oauthStorage.getTokenByAccess(tokenData.accessToken)).toBeNull();
		});
	});

	it("migrates legacy oauth_tokens schema without failing on missing new columns", async () => {
		const id = env.ACCOUNT.newUniqueId();
		const stub = env.ACCOUNT.get(id);

		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			const sql = (instance as unknown as { ctx: { storage: { sql: SqlStorage } } })
				.ctx.storage.sql;
			const now = Date.now();
			const issuedAt = now - 2 * 60 * 60 * 1000;
			const expiresAt = now - 60 * 1000;

			sql.exec(`
				CREATE TABLE oauth_tokens (
					access_token TEXT PRIMARY KEY,
					refresh_token TEXT NOT NULL UNIQUE,
					client_id TEXT NOT NULL,
					sub TEXT NOT NULL,
					scope TEXT NOT NULL,
					dpop_jkt TEXT,
					issued_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					revoked INTEGER NOT NULL DEFAULT 0
				);
			`);

			sql.exec(
				`INSERT INTO oauth_tokens
				(access_token, refresh_token, client_id, sub, scope, dpop_jkt, issued_at, expires_at, revoked)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				"legacy-access",
				"legacy-refresh",
				"did:web:app.example",
				env.DID,
				"atproto",
				null,
				issuedAt,
				expiresAt,
				0,
			);

			const oauthStorage = new SqliteOAuthStorage(sql);
			expect(() => oauthStorage.initSchema()).not.toThrow();

			const columns = sql
				.exec("PRAGMA table_info(oauth_tokens)")
				.toArray()
				.map((row) => row.name as string);

			expect(columns).toContain("access_expires_at");
			expect(columns).toContain("refresh_expires_at");
			expect(columns).not.toContain("expires_at");

			const migratedRow = sql
				.exec(
					`SELECT access_expires_at, refresh_expires_at FROM oauth_tokens WHERE access_token = ?`,
					"legacy-access",
				)
				.one();

			expect(migratedRow).toBeDefined();
			expect(migratedRow.access_expires_at as number).toBe(expiresAt);
			expect(migratedRow.refresh_expires_at as number).toBe(
				Math.max(expiresAt, issuedAt + REFRESH_TOKEN_TTL),
			);
		});
	});
});
