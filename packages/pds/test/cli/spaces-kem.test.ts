import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import * as p from "@clack/prompts";
import { spacesCommand } from "../../src/cli/commands/spaces.js";
import { setPublicVar } from "../../src/cli/utils/secrets.js";

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	note: vi.fn(),
	cancel: vi.fn(),
	confirm: vi.fn(async () => false),
	isCancel: vi.fn(() => false),
	log: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../../src/cli/utils/secrets.js", () => ({
	generateKemKeypair: vi.fn(async () => ({
		privateKey: "generated-private",
		publicKey: "zGenerated",
	})),
	setSecretValue: vi.fn(async () => {}),
	setPublicVar: vi.fn(),
}));

describe("pds spaces kem", () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		vi.clearAllMocks();
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "spaces-kem-test-"));
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeWranglerVars(vars: Record<string, string>) {
		writeFileSync(
			join(tempDir, "wrangler.jsonc"),
			JSON.stringify({ name: "test-worker", vars }),
		);
	}

	function writeDevVars(vars: Record<string, string>) {
		writeFileSync(
			join(tempDir, ".dev.vars"),
			Object.entries(vars)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(""),
		);
	}

	it("ignores a .dev.vars key when targeting production", async () => {
		writeWranglerVars({ DID: "did:web:pds.example.com" });
		writeDevVars({ SPACES_KEM_KEY_PUBLIC: "zLocal" });

		await runCommand(spacesCommand, { rawArgs: ["kem"] });

		expect(p.confirm).not.toHaveBeenCalled();
		expect(setPublicVar).toHaveBeenCalledWith(
			"SPACES_KEM_KEY_PUBLIC",
			"zGenerated",
			false,
		);
	});

	it("asks before replacing a production key", async () => {
		writeWranglerVars({
			DID: "did:web:pds.example.com",
			SPACES_KEM_KEY_PUBLIC: "zProduction",
		});

		await runCommand(spacesCommand, { rawArgs: ["kem"] });

		expect(p.confirm).toHaveBeenCalledOnce();
		expect(setPublicVar).not.toHaveBeenCalled();
	});

	it("does not publish a .dev.vars key for production", async () => {
		writeWranglerVars({ DID: "did:web:pds.example.com" });
		writeDevVars({ SPACES_KEM_KEY_PUBLIC: "zLocal" });

		await runCommand(spacesCommand, { rawArgs: ["kem", "--publish"] });

		expect(setPublicVar).toHaveBeenCalledWith(
			"SPACES_KEM_KEY_PUBLIC",
			"zGenerated",
			false,
		);
		expect(p.log.success).toHaveBeenCalledWith("Generated did:key:zGenerated");
	});

	it("checks .dev.vars for an existing key with --local", async () => {
		writeWranglerVars({
			DID: "did:web:pds.example.com",
			SPACES_KEM_KEY_PUBLIC: "zProduction",
		});

		await runCommand(spacesCommand, { rawArgs: ["kem", "--local"] });

		expect(p.confirm).not.toHaveBeenCalled();
		expect(setPublicVar).toHaveBeenCalledWith(
			"SPACES_KEM_KEY_PUBLIC",
			"zGenerated",
			true,
		);
	});

	it("asks before replacing a .dev.vars key with --local", async () => {
		writeWranglerVars({ DID: "did:web:pds.example.com" });
		writeDevVars({ SPACES_KEM_KEY_PUBLIC: "zLocal" });

		await runCommand(spacesCommand, { rawArgs: ["kem", "--local"] });

		expect(p.confirm).toHaveBeenCalledOnce();
		expect(setPublicVar).not.toHaveBeenCalled();
	});
});
