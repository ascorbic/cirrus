import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import * as p from "@clack/prompts";
import { migrateCommand } from "../../src/cli/commands/migrate.js";

const DID = "did:plc:abc123";

const pds = vi.hoisted(() => ({
	missing: [] as string[],
	recordsPerBlob: 1,
	uploadBlob: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	note: vi.fn(),
	cancel: vi.fn(),
	confirm: vi.fn(async () => true),
	password: vi.fn(async () => "source-password"),
	isCancel: vi.fn(() => false),
	spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
	log: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock("../../src/did-resolver.js", () => ({
	DidResolver: class {
		async resolve() {
			return {
				id: DID,
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://source.example.com",
					},
				],
			};
		}
	},
}));

vi.mock("../../src/cli/utils/pds-client.js", () => ({
	PDSClient: class {
		setAuthToken() {}
		async healthCheck() {
			return true;
		}
		async getAccountStatus() {
			return {
				activated: true,
				active: false,
				validDid: true,
				repoCommit: "bafyrepo",
				repoRev: "3krev",
				repoBlocks: 1000,
				indexedRecords: 500,
				expectedBlobs: 294,
				importedBlobs: 815,
			};
		}
		async describeRepo() {
			return {};
		}
		async getProfileStats() {
			return null;
		}
		async createSession() {
			return { accessJwt: "jwt" };
		}
		async getPreferences() {
			return [];
		}
		async listMissingBlobs() {
			return {
				blobs: pds.missing.flatMap((cid) =>
					Array.from({ length: pds.recordsPerBlob }, (_, i) => ({
						cid,
						recordUri: `at://${DID}/app.bsky.feed.post/${cid}${i}`,
					})),
				),
			};
		}
		async getBlob() {
			return { bytes: new Uint8Array([1]), mimeType: "image/png" };
		}
		async uploadBlob(...args: unknown[]) {
			await pds.uploadBlob(...args);
			pds.missing.shift();
		}
	},
}));

describe("pds migrate", () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		vi.clearAllMocks();
		pds.recordsPerBlob = 1;
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "migrate-test-"));
		writeFileSync(
			join(tempDir, "wrangler.jsonc"),
			JSON.stringify({
				name: "test-worker",
				vars: {
					PDS_HOSTNAME: "pds.example.com",
					DID,
					HANDLE: "alice.example.com",
				},
			}),
		);
		writeFileSync(join(tempDir, ".dev.vars"), "AUTH_TOKEN=token\n");
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("transfers missing migrated blobs when more blobs are stored than expected", async () => {
		pds.missing = ["bafy1", "bafy2", "bafy3"];

		await runCommand(migrateCommand, { rawArgs: [] });

		expect(p.note).toHaveBeenCalledWith(
			expect.stringContaining("291/294 images and videos transferred"),
			"Migration Progress",
		);
		expect(pds.uploadBlob).toHaveBeenCalledTimes(3);
		expect(p.log.success).toHaveBeenCalledWith("All packed and moved!");
	});

	it("reports the migrated blobs still missing after a failed transfer", async () => {
		pds.missing = ["bafy1", "bafy2", "bafy3"];
		pds.uploadBlob.mockRejectedValueOnce(new Error("upload failed"));

		await runCommand(migrateCommand, { rawArgs: [] });

		expect(p.log.warn).toHaveBeenCalledWith(
			"Migration partially complete. 1 images remaining.",
		);
	});

	it("transfers a blob shared by several records once", async () => {
		pds.missing = ["bafy1", "bafy2"];
		pds.recordsPerBlob = 2;

		await runCommand(migrateCommand, { rawArgs: [] });

		expect(pds.uploadBlob).toHaveBeenCalledTimes(2);
	});

	it("has nothing to do when no migrated blobs are missing", async () => {
		pds.missing = [];

		await runCommand(migrateCommand, { rawArgs: [] });

		expect(p.log.success).toHaveBeenCalledWith("Everything looks good!");
		expect(pds.uploadBlob).not.toHaveBeenCalled();
	});
});
