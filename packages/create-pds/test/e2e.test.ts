import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = join(__dirname, "..", "dist", "index.js");
const TEST_DIR = join(tmpdir(), "create-pds-test-" + Date.now());
const PROJECT_NAME = "test-pds-project";
const PROJECT_DIR = join(TEST_DIR, PROJECT_NAME);

describe("create-pds e2e", () => {
	beforeAll(() => {
		// Ensure CLI is built
		execSync("pnpm build", { cwd: join(__dirname, "..") });
		// Create test directory
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterAll(() => {
		// Clean up test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("scaffolds a new project with correct files", () => {
		// Run CLI
		execSync(
			`node ${CLI_PATH} ${PROJECT_NAME} --yes --skip-install --skip-init --skip-git`,
			{
				cwd: TEST_DIR,
				stdio: "pipe",
			},
		);

		// Verify directory was created
		expect(existsSync(PROJECT_DIR)).toBe(true);

		// Verify expected files exist
		const expectedFiles = [
			"package.json",
			"wrangler.jsonc",
			"vite.config.ts",
			"README.md",
			".gitignore",
			".env.example",
			"src/index.ts",
		];

		for (const file of expectedFiles) {
			expect(existsSync(join(PROJECT_DIR, file))).toBe(true);
		}
	});

	it("replaces placeholders in package.json", () => {
		const packageJson = JSON.parse(
			readFileSync(join(PROJECT_DIR, "package.json"), "utf-8"),
		);

		expect(packageJson.name).toBe(PROJECT_NAME);
		expect(packageJson.dependencies["@getcirrus/pds"]).toBeDefined();
	});

	it("includes correct worker entry point", () => {
		const indexTs = readFileSync(join(PROJECT_DIR, "src/index.ts"), "utf-8");

		expect(indexTs).toContain("@getcirrus/pds");
		expect(indexTs).toContain("AccountDurableObject");
	});

	it("fails if directory already exists in non-interactive mode", () => {
		expect(() => {
			execSync(
				`node ${CLI_PATH} ${PROJECT_NAME} --yes --skip-install --skip-init --skip-git`,
				{
					cwd: TEST_DIR,
					stdio: "pipe",
				},
			);
		}).toThrow();
	});
});
