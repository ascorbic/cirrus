import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readDevVars,
	writeDevVars,
	setDevVar,
} from "../../src/cli/utils/dotenv.js";

describe("dotenv utilities", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("readDevVars", () => {
		it("returns empty object when file does not exist", () => {
			const result = readDevVars(tempDir);
			expect(result).toEqual({});
		});

		it("parses simple key=value pairs", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "FOO=bar\nBAZ=qux\n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("handles values with equals signs", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "TOKEN=abc=def=ghi\n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ TOKEN: "abc=def=ghi" });
		});

		it("strips double quotes from values", () => {
			writeFileSync(join(tempDir, ".dev.vars"), 'NAME="hello world"\n');
			const result = readDevVars(tempDir);
			expect(result).toEqual({ NAME: "hello world" });
		});

		it("strips single quotes from values", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "NAME='hello world'\n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ NAME: "hello world" });
		});

		it("ignores comment lines", () => {
			writeFileSync(
				join(tempDir, ".dev.vars"),
				"# This is a comment\nFOO=bar\n# Another comment\n",
			);
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "bar" });
		});

		it("ignores empty lines", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "FOO=bar\n\n\nBAZ=qux\n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("ignores lines without equals sign", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "INVALID_LINE\nFOO=bar\n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "bar" });
		});

		it("trims whitespace around keys and values", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "  FOO  =  bar  \n");
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "bar" });
		});
	});

	describe("writeDevVars", () => {
		it("writes vars to new file", () => {
			writeDevVars({ FOO: "bar", BAZ: "qux" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe("FOO=bar\nBAZ=qux\n");
		});

		it("quotes values with spaces", () => {
			writeDevVars({ NAME: "hello world" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe('NAME="hello world"\n');
		});

		it("escapes double quotes in values", () => {
			writeDevVars({ NAME: 'say "hello"' }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe('NAME="say \\"hello\\""\n');
		});

		it("preserves comments when updating", () => {
			writeFileSync(
				join(tempDir, ".dev.vars"),
				"# Header comment\nFOO=old\n# Footer\n",
			);
			writeDevVars({ FOO: "new" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe("# Header comment\nFOO=new\n# Footer\n");
		});

		it("preserves existing vars not in update", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "FOO=bar\nBAZ=qux\n");
			writeDevVars({ FOO: "updated" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe("FOO=updated\nBAZ=qux\n");
		});

		it("adds new vars at the end", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "FOO=bar");
			writeDevVars({ FOO: "bar", NEW: "value" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe("FOO=bar\nNEW=value\n");
		});

		it("ensures trailing newline", () => {
			writeDevVars({ FOO: "bar" }, tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content.endsWith("\n")).toBe(true);
		});
	});

	describe("setDevVar", () => {
		it("creates file with single var if not exists", () => {
			setDevVar("FOO", "bar", tempDir);
			const content = readFileSync(join(tempDir, ".dev.vars"), "utf-8");
			expect(content).toBe("FOO=bar\n");
		});

		it("adds var to existing file", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "EXISTING=value\n");
			setDevVar("NEW", "added", tempDir);
			const result = readDevVars(tempDir);
			expect(result).toEqual({ EXISTING: "value", NEW: "added" });
		});

		it("updates existing var", () => {
			writeFileSync(join(tempDir, ".dev.vars"), "FOO=old\n");
			setDevVar("FOO", "new", tempDir);
			const result = readDevVars(tempDir);
			expect(result).toEqual({ FOO: "new" });
		});
	});
});
