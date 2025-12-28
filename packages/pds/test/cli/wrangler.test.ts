import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVar, setVars, getVars } from "../../src/cli/utils/wrangler.js";

describe("wrangler utilities", () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "wrangler-test-"));
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeConfig(config: Record<string, unknown>) {
		writeFileSync(
			join(tempDir, "wrangler.jsonc"),
			JSON.stringify(config, null, "\t"),
		);
		process.chdir(tempDir);
	}

	function readConfig(): Record<string, unknown> {
		return JSON.parse(readFileSync(join(tempDir, "wrangler.jsonc"), "utf-8"));
	}

	describe("getVars", () => {
		it("returns vars from config", () => {
			writeConfig({
				vars: {
					PDS_HOSTNAME: "pds.example.com",
					DID: "did:web:pds.example.com",
				},
			});

			const result = getVars();
			expect(result).toEqual({
				PDS_HOSTNAME: "pds.example.com",
				DID: "did:web:pds.example.com",
			});
		});

		it("returns empty object when no vars", () => {
			writeConfig({ name: "test-worker" });

			const result = getVars();
			expect(result).toEqual({});
		});
	});

	describe("setVar", () => {
		it("adds var to existing config", () => {
			writeConfig({ name: "test-worker", vars: {} });

			setVar("PDS_HOSTNAME", "pds.example.com");

			const config = readConfig();
			expect(config.vars).toEqual({ PDS_HOSTNAME: "pds.example.com" });
		});

		it("updates existing var", () => {
			writeConfig({
				name: "test-worker",
				vars: { PDS_HOSTNAME: "old.example.com" },
			});

			setVar("PDS_HOSTNAME", "new.example.com");

			const config = readConfig();
			expect((config.vars as Record<string, string>).PDS_HOSTNAME).toBe(
				"new.example.com",
			);
		});

		it("preserves other vars when setting one", () => {
			writeConfig({
				name: "test-worker",
				vars: { DID: "did:web:example.com" },
			});

			setVar("PDS_HOSTNAME", "pds.example.com");

			const config = readConfig();
			expect(config.vars).toEqual({
				DID: "did:web:example.com",
				PDS_HOSTNAME: "pds.example.com",
			});
		});

		it("throws when no config found", () => {
			// Don't write config, just chdir to empty temp dir
			process.chdir(tempDir);

			expect(() => setVar("PDS_HOSTNAME", "test")).toThrow(
				"No wrangler config found",
			);
		});
	});

	describe("setVars", () => {
		it("sets multiple vars at once", () => {
			writeConfig({ name: "test-worker", vars: {} });

			setVars({
				PDS_HOSTNAME: "pds.example.com",
				DID: "did:web:pds.example.com",
				HANDLE: "alice.example.com",
			});

			const config = readConfig();
			expect(config.vars).toEqual({
				PDS_HOSTNAME: "pds.example.com",
				DID: "did:web:pds.example.com",
				HANDLE: "alice.example.com",
			});
		});

		it("merges with existing vars", () => {
			writeConfig({
				name: "test-worker",
				vars: { EXISTING: "value", PDS_HOSTNAME: "old.example.com" },
			});

			setVars({ PDS_HOSTNAME: "new.example.com", DID: "did:web:example.com" });

			const config = readConfig();
			expect(config.vars).toEqual({
				EXISTING: "value",
				PDS_HOSTNAME: "new.example.com",
				DID: "did:web:example.com",
			});
		});

		it("throws when no config found", () => {
			process.chdir(tempDir);

			expect(() => setVars({ PDS_HOSTNAME: "test" })).toThrow(
				"No wrangler config found",
			);
		});
	});
});
