import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderUpgradeGuide, writeUpgradeGuide } from "../src/guide.js";
import type { UpgradePlan } from "../src/types.js";

const plan: UpgradePlan = {
	projectRoot: "/pds",
	packageManager: "pnpm",
	tag: "latest",
	dependencies: [
		{
			name: "@getcirrus/pds",
			section: "dependencies",
			from: "^0.18.0",
			to: "^0.19.0",
			fromVersion: "0.18.0",
			toVersion: "0.19.0",
		},
	],
	skipped: [],
	transitive: [
		{
			name: "@getcirrus/oauth-provider",
			fromVersion: "0.5.0",
			toVersion: "0.6.0",
		},
		{ name: "@getcirrus/spaces", toVersion: "0.1.0" },
	],
	changelog: [
		{
			body: "Add spaces.\n\n  Add the `SPACES` binding.",
			occurrences: [
				{
					packageName: "@getcirrus/pds",
					version: "0.19.0",
					category: "minor",
					source: "[#219](https://github.com/ascorbic/cirrus/pull/219)",
				},
			],
		},
		{
			body: "Shared fix.",
			occurrences: [
				{ packageName: "@getcirrus/pds", version: "0.19.0", category: "patch" },
				{
					packageName: "@getcirrus/spaces",
					version: "0.1.0",
					category: "patch",
				},
			],
		},
	],
	referenceProject:
		"https://github.com/ascorbic/cirrus/tree/@getcirrus/pds@0.19.0/packages/create-pds/templates/pds-worker",
	guidePath: "/pds/.cirrus/UPGRADE.md",
	commands: {
		install: "pnpm install",
		build: "pnpm run build",
		dev: "pnpm run dev",
		deploy: "pnpm run deploy",
		statusDev: "pnpm exec pds status --dev",
		status: "pnpm exec pds status",
	},
};

describe("renderUpgradeGuide", () => {
	const guide = renderUpgradeGuide(plan);

	it("lists direct and transitive package changes", () => {
		expect(guide).toContain(
			"- `@getcirrus/pds`: `0.18.0` → `0.19.0` (`^0.18.0` → `^0.19.0`)",
		);
		expect(guide).toContain("- `@getcirrus/oauth-provider`: `0.5.0` → `0.6.0`");
		expect(guide).toContain("- `@getcirrus/spaces`: added at `0.1.0`");
	});

	it("includes every release entry in full with where it applies", () => {
		expect(guide).toContain(
			"### Change 1\n\nApplies to: `@getcirrus/pds@0.19.0` (minor)  \nSource: [#219](https://github.com/ascorbic/cirrus/pull/219)\n\nAdd spaces.\n\n  Add the `SPACES` binding.",
		);
		expect(guide).toContain(
			"### Change 2\n\nApplies to: `@getcirrus/pds@0.19.0` (patch), `@getcirrus/spaces@0.1.0` (patch)\n\nShared fix.",
		);
	});

	it("points at the reference project for the target release", () => {
		expect(guide).toContain(plan.referenceProject);
		expect(guide).toContain("`package.json.tmpl`");
	});

	it("gives the build, deploy, and verification commands in order", () => {
		const commands = [
			"pnpm run build",
			"pnpm run dev",
			"pnpm exec pds status --dev",
			"pnpm run deploy",
			"pnpm exec pds status",
		].map((command) => guide.indexOf(`\n${command}\n`));

		expect(commands.every((index) => index > 0)).toBe(true);
		expect(commands).toEqual([...commands].sort((a, b) => a - b));
	});

	it("says so when nothing changed", () => {
		const unchanged = renderUpgradeGuide({
			...plan,
			dependencies: [],
			transitive: [],
			changelog: [],
		});

		expect(unchanged).toContain(
			"All direct Cirrus packages were already on the `latest` release.",
		);
		expect(unchanged).toContain("No release entries were crossed");
	});

	it("names the packages it left alone", () => {
		const skipped = renderUpgradeGuide({
			...plan,
			skipped: [
				{
					name: "@getcirrus/oauth-provider",
					specifier: "workspace:*",
					reason: "it comes from a package in this workspace, not from npm",
				},
			],
		});

		expect(skipped).toContain(
			"- `@getcirrus/oauth-provider` (`workspace:*`) was not changed: it comes from a package in this workspace, not from npm.",
		);
	});

	it("describes a work order regenerated from an earlier version", () => {
		const regenerated = renderUpgradeGuide({
			...plan,
			from: "0.18.0",
			dependencies: [],
		});

		expect(regenerated).toContain(
			"It covers the releases after `@getcirrus/pds` `0.18.0`, the version given with `--from`.",
		);
		expect(regenerated).toContain("The updater did not change any package.");
		expect(regenerated).not.toContain("changed the Cirrus packages listed");
	});
});

describe("writeUpgradeGuide", () => {
	const directories: string[] = [];

	async function planIn(): Promise<UpgradePlan> {
		const root = await mkdtemp(join(tmpdir(), "upgrade-pds-guide-"));
		directories.push(root);
		return {
			...plan,
			projectRoot: root,
			guidePath: join(root, ".cirrus", "UPGRADE.md"),
		};
	}

	const exists = (path: string) =>
		stat(path).then(
			() => true,
			() => false,
		);

	afterEach(async () => {
		await Promise.all(
			directories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("writes the work order into a directory that git ignores", async () => {
		const target = await planIn();

		await writeUpgradeGuide(target);

		expect(await readFile(target.guidePath, "utf8")).toBe(
			renderUpgradeGuide(target),
		);
		expect(
			await readFile(join(target.projectRoot, ".cirrus", ".gitignore"), "utf8"),
		).toBe("*\n");
	});

	it("keeps a .gitignore the project already has there", async () => {
		const target = await planIn();
		const ignore = join(target.projectRoot, ".cirrus", ".gitignore");
		await mkdir(join(target.projectRoot, ".cirrus"));
		await writeFile(ignore, "UPGRADE.md\n");

		const written = await writeUpgradeGuide(target);
		await written.undo();

		expect(await readFile(ignore, "utf8")).toBe("UPGRADE.md\n");
		expect(await exists(target.guidePath)).toBe(false);
	});

	it("removes everything it created when undone", async () => {
		const target = await planIn();

		const written = await writeUpgradeGuide(target);
		await written.undo();

		expect(await exists(join(target.projectRoot, ".cirrus"))).toBe(false);
	});

	it("puts an earlier work order back when undone", async () => {
		const target = await planIn();
		await mkdir(join(target.projectRoot, ".cirrus"));
		await writeFile(target.guidePath, "earlier\n");

		const written = await writeUpgradeGuide(target);
		await written.undo();

		expect(await readFile(target.guidePath, "utf8")).toBe("earlier\n");
	});
});
