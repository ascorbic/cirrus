import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock child_process before importing the module
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process");
	return {
		...actual,
		spawn: vi.fn(),
	};
});

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	detectPackageManager,
	formatCommand,
	copyToClipboard,
	is1PasswordAvailable,
	saveKeyBackup,
	getTargetUrl,
	getDomain,
} from "../../src/cli/utils/cli-helpers.js";

describe("detectPackageManager", () => {
	const originalUserAgent = process.env.npm_config_user_agent;

	afterEach(() => {
		if (originalUserAgent !== undefined) {
			process.env.npm_config_user_agent = originalUserAgent;
		} else {
			delete process.env.npm_config_user_agent;
		}
	});

	it("detects npm", () => {
		process.env.npm_config_user_agent = "npm/9.6.0 node/v18.0.0";
		expect(detectPackageManager()).toBe("npm");
	});

	it("detects yarn", () => {
		process.env.npm_config_user_agent = "yarn/1.22.19 npm/? node/v18.0.0";
		expect(detectPackageManager()).toBe("yarn");
	});

	it("detects pnpm", () => {
		process.env.npm_config_user_agent = "pnpm/8.6.0 npm/? node/v18.0.0";
		expect(detectPackageManager()).toBe("pnpm");
	});

	it("detects bun", () => {
		process.env.npm_config_user_agent = "bun/1.0.0";
		expect(detectPackageManager()).toBe("bun");
	});

	it("defaults to npm when unrecognized", () => {
		process.env.npm_config_user_agent = "";
		expect(detectPackageManager()).toBe("npm");
	});

	it("defaults to npm when undefined", () => {
		delete process.env.npm_config_user_agent;
		expect(detectPackageManager()).toBe("npm");
	});
});

describe("formatCommand", () => {
	it("adds 'run' for npm", () => {
		expect(formatCommand("npm", "dev")).toBe("npm run dev");
		expect(formatCommand("npm", "pds", "init")).toBe("npm run pds init");
	});

	it("omits 'run' for yarn", () => {
		expect(formatCommand("yarn", "dev")).toBe("yarn dev");
		expect(formatCommand("yarn", "pds", "init")).toBe("yarn pds init");
	});

	it("omits 'run' for pnpm except deploy", () => {
		expect(formatCommand("pnpm", "dev")).toBe("pnpm dev");
		expect(formatCommand("pnpm", "pds", "init")).toBe("pnpm pds init");
		// deploy is special - pnpm has a built-in deploy command
		expect(formatCommand("pnpm", "deploy")).toBe("pnpm run deploy");
	});

	it("omits 'run' for bun", () => {
		expect(formatCommand("bun", "dev")).toBe("bun dev");
		expect(formatCommand("bun", "pds", "migrate")).toBe("bun pds migrate");
	});
});

describe("getTargetUrl", () => {
	const originalPort = process.env.PORT;

	afterEach(() => {
		if (originalPort !== undefined) {
			process.env.PORT = originalPort;
		} else {
			delete process.env.PORT;
		}
	});

	it("returns localhost URL in dev mode", () => {
		delete process.env.PORT;
		expect(getTargetUrl(true, "pds.example.com")).toBe("http://localhost:5173");
	});

	it("uses PORT env var in dev mode", () => {
		process.env.PORT = "8080";
		expect(getTargetUrl(true, "pds.example.com")).toBe("http://localhost:8080");
	});

	it("returns https URL in production mode", () => {
		expect(getTargetUrl(false, "pds.example.com")).toBe(
			"https://pds.example.com",
		);
	});

	it("throws when hostname missing in production", () => {
		expect(() => getTargetUrl(false, undefined)).toThrow(
			"PDS_HOSTNAME not configured",
		);
	});
});

describe("getDomain", () => {
	it("extracts domain from URL", () => {
		expect(getDomain("https://example.com/path")).toBe("example.com");
		expect(getDomain("http://localhost:5173")).toBe("localhost");
	});

	it("returns input if not a valid URL", () => {
		expect(getDomain("not-a-url")).toBe("not-a-url");
		expect(getDomain("example.com")).toBe("example.com");
	});
});

describe("copyToClipboard", () => {
	function createMockChildProcess(exitCode: number): ChildProcess {
		const emitter = new EventEmitter() as ChildProcess;
		const stdin = new EventEmitter() as NodeJS.WritableStream;
		stdin.write = vi.fn().mockReturnValue(true);
		stdin.end = vi.fn();
		emitter.stdin = stdin;
		emitter.stdout = null;
		emitter.stderr = null;

		// Emit close event on next tick
		process.nextTick(() => emitter.emit("close", exitCode));

		return emitter;
	}

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
	});

	it("uses pbcopy on macOS", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

		const result = await copyToClipboard("test-text");

		expect(spawn).toHaveBeenCalledWith("pbcopy", [], expect.any(Object));
		expect(result).toBe(true);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("uses xclip on Linux", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

		const result = await copyToClipboard("test-text");

		expect(spawn).toHaveBeenCalledWith(
			"xclip",
			["-selection", "clipboard"],
			expect.any(Object),
		);
		expect(result).toBe(true);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("uses clip on Windows", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

		const result = await copyToClipboard("test-text");

		expect(spawn).toHaveBeenCalledWith("clip", [], expect.any(Object));
		expect(result).toBe(true);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("returns false on unknown platform", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "freebsd" });

		const result = await copyToClipboard("test-text");

		expect(spawn).not.toHaveBeenCalled();
		expect(result).toBe(false);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("returns false on command failure", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(1));

		const result = await copyToClipboard("test-text");

		expect(result).toBe(false);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("writes text to stdin", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		const mockChild = createMockChildProcess(0);
		vi.mocked(spawn).mockReturnValue(mockChild);

		await copyToClipboard("my-secret-key");

		expect(mockChild.stdin?.write).toHaveBeenCalledWith("my-secret-key");
		expect(mockChild.stdin?.end).toHaveBeenCalled();

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});

describe("is1PasswordAvailable", () => {
	function createMockChildProcess(exitCode: number): ChildProcess {
		const emitter = new EventEmitter() as ChildProcess;
		emitter.stdin = null;
		emitter.stdout = new EventEmitter() as NodeJS.ReadableStream;
		emitter.stderr = null;

		process.nextTick(() => emitter.emit("close", exitCode));

		return emitter;
	}

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
	});

	it("returns false on Windows", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });

		const result = await is1PasswordAvailable();

		expect(spawn).not.toHaveBeenCalled();
		expect(result).toBe(false);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("returns true when op is found", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

		const result = await is1PasswordAvailable();

		expect(spawn).toHaveBeenCalledWith("which", ["op"], expect.any(Object));
		expect(result).toBe(true);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("returns false when op is not found", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(1));

		const result = await is1PasswordAvailable();

		expect(result).toBe(false);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("works on Linux", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux" });

		vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

		const result = await is1PasswordAvailable();

		expect(spawn).toHaveBeenCalledWith("which", ["op"], expect.any(Object));
		expect(result).toBe(true);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});

describe("saveKeyBackup", () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "key-backup-test-"));
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates backup file with key content", async () => {
		const testKey = "abc123def456";
		const filepath = await saveKeyBackup(testKey, "alice.example.com");

		expect(filepath).toContain("signing-key-backup-alice-example-com.txt");

		const content = readFileSync(filepath, "utf-8");
		expect(content).toContain(testKey);
		expect(content).toContain("alice.example.com");
		expect(content).toContain("CIRRUS PDS SIGNING KEY BACKUP");
		expect(content).toContain("WARNING: This key controls your identity!");
	});

	it("sanitizes handle for filename", async () => {
		const filepath = await saveKeyBackup("key", "user@weird/handle.com");

		expect(filepath).toContain("signing-key-backup-user-weird-handle-com.txt");
	});

	it("sets restrictive file permissions", async () => {
		const filepath = await saveKeyBackup("key", "test.com");

		const stats = statSync(filepath);
		// 0o600 = owner read/write only
		// On some systems the mode includes file type bits, so we mask with 0o777
		expect(stats.mode & 0o777).toBe(0o600);
	});

	it("includes timestamp in content", async () => {
		const before = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		const filepath = await saveKeyBackup("key", "test.com");
		const content = readFileSync(filepath, "utf-8");

		// Should contain a date matching today
		expect(content).toMatch(/Created: \d{4}-\d{2}-\d{2}/);
		expect(content).toContain(before);
	});
});
