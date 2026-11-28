import { describe, expect, it } from "vitest";

import { renderUpgradeGuide } from "../src/guide.js";
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
});
