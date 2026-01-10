import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setVar,
	setVars,
	getVars,
	parseSecretListOutput,
} from "../../src/cli/utils/wrangler.js";

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

describe("parseSecretListOutput", () => {
	it("parses JSON array format", () => {
		const jsonOutput = JSON.stringify([
			{ name: "AUTH_TOKEN", type: "secret_text" },
			{ name: "SIGNING_KEY", type: "secret_text" },
			{ name: "JWT_SECRET", type: "secret_text" },
		]);

		const result = parseSecretListOutput(jsonOutput);
		expect(result).toEqual(["AUTH_TOKEN", "SIGNING_KEY", "JWT_SECRET"]);
	});

	it("handles empty JSON array", () => {
		const result = parseSecretListOutput("[]");
		expect(result).toEqual([]);
	});

	it("parses table format as fallback", () => {
		// Wrangler sometimes outputs a table format
		const tableOutput = `
┌──────────────┬─────────────┐
│ Name         │ Type        │
├──────────────┼─────────────┤
│ AUTH_TOKEN   │ secret_text │
│ SIGNING_KEY  │ secret_text │
└──────────────┴─────────────┘
`;

		const result = parseSecretListOutput(tableOutput);
		expect(result).toEqual(["AUTH_TOKEN", "SIGNING_KEY"]);
	});

	it("excludes header row in table format", () => {
		const tableOutput = `│ Name │ Type │\n│ MY_SECRET │ secret_text │`;

		const result = parseSecretListOutput(tableOutput);
		expect(result).toEqual(["MY_SECRET"]);
		expect(result).not.toContain("Name");
	});

	it("returns empty array for invalid input", () => {
		expect(parseSecretListOutput("not json")).toEqual([]);
		expect(parseSecretListOutput("")).toEqual([]);
		expect(parseSecretListOutput("{}")).toEqual([]);
	});

	it("returns empty array for non-array JSON", () => {
		const result = parseSecretListOutput('{"name": "test"}');
		expect(result).toEqual([]);
	});

	it("handles secrets with underscore names", () => {
		const jsonOutput = JSON.stringify([
			{ name: "PASSWORD_HASH", type: "secret_text" },
			{ name: "SIGNING_KEY_PUBLIC", type: "secret_text" },
		]);

		const result = parseSecretListOutput(jsonOutput);
		expect(result).toEqual(["PASSWORD_HASH", "SIGNING_KEY_PUBLIC"]);
	});
});
