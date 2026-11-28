import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	applyDependencyEdits,
	detectPackageManager,
	execCommand,
	loadProject,
	runScript,
	targetSpecifier,
	writeDependenciesAndInstall,
} from "../src/project.js";
import type { DependencyChange } from "../src/types.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "upgrade-pds-"));
	directories.push(directory);
	return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

async function createProject(
	packageJson: Record<string, unknown>,
	installed: Record<string, string>,
): Promise<string> {
	const root = await tempDir();
	await writeJson(join(root, "package.json"), packageJson);
	for (const [name, version] of Object.entries(installed)) {
		await writeJson(join(root, "node_modules", name, "package.json"), {
			name,
			version,
		});
	}
	return root;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("targetSpecifier", () => {
	it("preserves caret, tilde, and exact version styles", () => {
		expect(targetSpecifier("^0.18.0", "0.19.0")).toBe("^0.19.0");
		expect(targetSpecifier("~0.18.0", "0.19.0")).toBe("~0.19.0");
		expect(targetSpecifier("0.18.0", "0.19.0")).toBe("0.19.0");
	});

	it("replaces preview builds, git sources, and other ranges with a caret release", () => {
		for (const specifier of [
			"https://pkg.pr.new/ascorbic/cirrus/@getcirrus/pds@250",
			"git+https://github.com/ascorbic/cirrus.git#main",
			"github:ascorbic/cirrus",
			">=0.18.0",
			"0.x",
			"latest",
		]) {
			expect(targetSpecifier(specifier, "0.19.0")).toBe("^0.19.0");
		}
	});

	it("leaves catalog, workspace, local path, and alias specifiers to the project", () => {
		for (const specifier of [
			"catalog:",
			"workspace:*",
			"link:../pds",
			"file:../pds",
			"portal:../pds",
			"npm:@example/pds@^1.0.0",
		]) {
			expect(targetSpecifier(specifier, "0.19.0")).toBeNull();
		}
	});
});

describe("applyDependencyEdits", () => {
	it("changes only the named dependencies and keeps the file's formatting", () => {
		const source =
			'{\n  "dependencies": { "@getcirrus/pds": "^0.18.0", "hono": "^4.0.0" },\n  "devDependencies": { "wrangler": "^4.54.0" }\n}\n';
		const changes: DependencyChange[] = [
			{
				name: "@getcirrus/pds",
				section: "dependencies",
				from: "^0.18.0",
				to: "^0.19.0",
				fromVersion: "0.18.0",
				toVersion: "0.19.0",
			},
		];

		expect(applyDependencyEdits(source, changes)).toBe(
			'{\n  "dependencies": { "@getcirrus/pds": "^0.19.0", "hono": "^4.0.0" },\n  "devDependencies": { "wrangler": "^4.54.0" }\n}\n',
		);
	});
});

describe("detectPackageManager", () => {
	it("prefers the packageManager field", async () => {
		const root = await tempDir();
		await writeFile(join(root, "package-lock.json"), "{}");

		expect(await detectPackageManager(root, "pnpm@11.24.0")).toEqual({
			packageManager: "pnpm",
			lockfileDirectory: root,
		});
	});

	it("falls back to the nearest lockfile, searching parent directories", async () => {
		const workspace = await tempDir();
		const root = join(workspace, "apps", "pds");
		await mkdir(root, { recursive: true });
		await writeFile(join(workspace, "yarn.lock"), "");

		expect(await detectPackageManager(root)).toEqual({
			packageManager: "yarn",
			lockfileDirectory: workspace,
		});
	});

	it("looks for the declared package manager's own lockfile", async () => {
		const workspace = await tempDir();
		const root = join(workspace, "pds");
		await mkdir(root, { recursive: true });
		await writeFile(join(workspace, "pnpm-lock.yaml"), "");
		await writeFile(join(root, "package-lock.json"), "{}");

		expect(await detectPackageManager(root, "pnpm@11.24.0")).toEqual({
			packageManager: "pnpm",
			lockfileDirectory: workspace,
		});
	});
});

describe("package manager commands", () => {
	it("runs scripts with an explicit run subcommand", () => {
		expect(runScript("pnpm", "deploy")).toBe("pnpm run deploy");
		expect(runScript("npm", "build")).toBe("npm run build");
		expect(runScript("yarn", "build")).toBe("yarn run build");
		expect(runScript("bun", "build")).toBe("bun run build");
	});

	it("uses each package manager's project-local binary runner", () => {
		expect(execCommand("pnpm", "pds status")).toBe("pnpm exec pds status");
		expect(execCommand("npm", "pds status")).toBe("npm exec -- pds status");
		expect(execCommand("yarn", "pds status")).toBe("yarn pds status");
		expect(execCommand("bun", "pds status")).toBe("bunx pds status");
	});
});

describe("loadProject", () => {
	it("collects direct Cirrus dependencies with their installed versions", async () => {
		const root = await createProject(
			{
				packageManager: "pnpm@11.24.0",
				dependencies: { "@getcirrus/pds": "^0.17.0", hono: "^4.0.0" },
				devDependencies: { "@getcirrus/oauth-provider": "0.5.0" },
			},
			{
				"@getcirrus/pds": "0.17.1",
				"@getcirrus/oauth-provider": "0.5.0",
				hono: "4.11.3",
			},
		);

		const project = await loadProject(join(root));

		expect(project.packageManager).toBe("pnpm");
		expect(project.dependencies).toEqual([
			{
				name: "@getcirrus/pds",
				section: "dependencies",
				specifier: "^0.17.0",
				installedVersion: "0.17.1",
			},
			{
				name: "@getcirrus/oauth-provider",
				section: "devDependencies",
				specifier: "0.5.0",
				installedVersion: "0.5.0",
			},
		]);
	});

	it("finds the project from a nested directory", async () => {
		const root = await createProject(
			{ dependencies: { "@getcirrus/pds": "^0.19.0" } },
			{ "@getcirrus/pds": "0.19.0" },
		);
		await mkdir(join(root, "src"));

		const project = await loadProject(join(root, "src"));

		expect(project.packageJsonPath).toBe(
			join(project.root, "package.json"),
		);
		expect(project.dependencies).toHaveLength(1);
	});

	it("rejects a project that does not depend on @getcirrus/pds", async () => {
		const root = await createProject({ dependencies: { hono: "^4.0.0" } }, {});

		await expect(loadProject(root)).rejects.toThrow(
			"does not declare @getcirrus/pds",
		);
	});

	it("asks for an install when the package is missing from node_modules", async () => {
		const root = await createProject(
			{ dependencies: { "@getcirrus/pds": "^0.19.0" } },
			{},
		);

		await expect(loadProject(root)).rejects.toThrow(
			"Install the project's dependencies",
		);
	});
});

describe("writeDependenciesAndInstall", () => {
	const change: DependencyChange = {
		name: "@getcirrus/pds",
		section: "dependencies",
		from: "^0.18.0",
		to: "^0.19.0",
		fromVersion: "0.18.0",
		toVersion: "0.19.0",
	};

	async function installedProject() {
		const root = await createProject(
			{
				packageManager: "pnpm@11.24.0",
				dependencies: { "@getcirrus/pds": "^0.18.0" },
			},
			{ "@getcirrus/pds": "0.18.0" },
		);
		await writeFile(join(root, "pnpm-lock.yaml"), "before\n");
		return loadProject(root);
	}

	it("writes the specifiers, installs, and returns the verification result", async () => {
		const project = await installedProject();
		const runs: string[] = [];

		const result = await writeDependenciesAndInstall(
			project,
			[change],
			async () => "verified",
			async (command, args, cwd) => {
				runs.push(`${command} ${args.join(" ")} in ${cwd}`);
			},
		);

		expect(result).toBe("verified");
		expect(runs).toEqual([`pnpm install in ${project.root}`]);
		expect(
			JSON.parse(await readFile(project.packageJsonPath, "utf8")).dependencies,
		).toEqual({ "@getcirrus/pds": "^0.19.0" });
	});

	it("does not install when there is nothing to change", async () => {
		const project = await installedProject();
		let installs = 0;

		await writeDependenciesAndInstall(
			project,
			[],
			async () => undefined,
			async () => {
				installs++;
			},
		);

		expect(installs).toBe(0);
	});

	it("restores package.json and the lockfile when the install fails", async () => {
		const project = await installedProject();
		let installs = 0;

		await expect(
			writeDependenciesAndInstall(
				project,
				[change],
				async () => undefined,
				async () => {
					installs++;
					if (installs === 1) {
						await writeFile(join(project.root, "pnpm-lock.yaml"), "after\n");
						throw new Error("pnpm failed with exit code 1.");
					}
				},
			),
		).rejects.toThrow(
			"pnpm failed with exit code 1. The previous dependencies were restored.",
		);

		expect(installs).toBe(2);
		expect(await readFile(project.packageJsonPath, "utf8")).toBe(
			project.packageJsonSource,
		);
		expect(await readFile(join(project.root, "pnpm-lock.yaml"), "utf8")).toBe(
			"before\n",
		);
	});

	it("restores the project when verification fails after a successful install", async () => {
		const project = await installedProject();

		await expect(
			writeDependenciesAndInstall(
				project,
				[change],
				async () => {
					throw new Error("@getcirrus/pds resolved to 0.18.0.");
				},
				async () => {},
			),
		).rejects.toThrow("The previous dependencies were restored.");

		expect(await readFile(project.packageJsonPath, "utf8")).toBe(
			project.packageJsonSource,
		);
	});
});
