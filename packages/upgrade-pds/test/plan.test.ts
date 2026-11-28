import { describe, expect, it } from "vitest";

import { createUpgradePlan } from "../src/plan.js";
import type { ProjectState } from "../src/project.js";
import type { ProjectDependency } from "../src/types.js";
import { jsonResponse, requestUrl } from "./helpers.js";

function project(
	dependencies: ProjectDependency[],
	scripts: Record<string, string> = {
		dev: "vite dev",
		build: "vite build",
		deploy: "vite build && wrangler deploy",
	},
	transitive: Record<string, string> = { "@getcirrus/oauth-provider": "0.5.0" },
): ProjectState {
	const packageJson = { scripts };
	return {
		root: "/pds",
		lockfileDirectory: "/pds",
		packageJsonPath: "/pds/package.json",
		packageJsonSource: `${JSON.stringify(packageJson)}\n`,
		packageJson,
		packageManager: "pnpm",
		dependencies,
		transitive,
	};
}

const pds = (
	installedVersion: string,
	specifier = `^${installedVersion}`,
): ProjectDependency => ({
	name: "@getcirrus/pds",
	section: "dependencies",
	specifier,
	installedVersion,
});

const DIRECTORIES: Record<string, string> = {
	"@getcirrus/pds": "packages/pds",
	"@getcirrus/oauth-provider": "packages/oauth-provider",
	"@getcirrus/spaces": "packages/spaces",
};

const PDS_DEPENDENCIES: Record<string, Record<string, string>> = {
	"0.18.0": { "@getcirrus/oauth-provider": "0.5.0" },
	"0.19.0": {
		"@getcirrus/oauth-provider": "0.6.0",
		"@getcirrus/spaces": "0.1.0",
	},
};

const CHANGELOGS: Record<string, string> = {
	"packages/pds": `## 0.19.0\n\n### Minor Changes\n\n- Add spaces.\n\n### Patch Changes\n\n- Updated dependencies [[\`5762e22\`](https://github.com/ascorbic/cirrus/commit/5762e22)]:\n  - @getcirrus/oauth-provider@0.6.0\n\n## 0.18.0\n\n### Minor Changes\n\n- Proxy reports.\n`,
	"packages/oauth-provider": `## 0.6.0\n\n### Minor Changes\n\n- Add space scopes.\n\n## 0.5.0\n\n### Minor Changes\n\n- Granular scopes.\n`,
	"packages/spaces": `## 0.1.0\n\n### Minor Changes\n\n- Initial spaces engine.\n`,
};

function registry(latest: string, requests: string[] = []): typeof fetch {
	return async (input) => {
		const url = requestUrl(input);
		requests.push(url.href);
		if (url.hostname === "registry.npmjs.org") {
			const [scope, rest] = decodeURIComponent(url.pathname)
				.slice(1)
				.split("/");
			const name = `${scope}/${rest}`;
			const requested = decodeURIComponent(url.pathname).split("/").at(-1)!;
			const version = requested === "latest" ? latest : requested;
			return jsonResponse({
				name,
				version,
				repository: {
					url: "git+https://github.com/ascorbic/cirrus.git",
					directory: DIRECTORIES[name],
				},
				dependencies:
					name === "@getcirrus/pds" ? PDS_DEPENDENCIES[version] : {},
			});
		}
		const directory = Object.keys(CHANGELOGS).find((candidate) =>
			url.pathname.includes(`/${candidate}/`),
		);
		return new Response(CHANGELOGS[directory!]);
	};
}

describe("createUpgradePlan", () => {
	it("plans from a preview build whose version is not on npm", async () => {
		const requests: string[] = [];
		const plan = await createUpgradePlan(
			project([
				pds(
					"0.18.1-pr.230",
					"https://pkg.pr.new/ascorbic/cirrus/@getcirrus/pds@230",
				),
			]),
			"latest",
			registry("0.19.0", requests),
		);

		expect(plan.dependencies[0]).toMatchObject({ to: "^0.19.0" });
		expect(plan.transitive).toHaveLength(2);
		expect(requests.some((url) => url.includes("0.18.1-pr.230"))).toBe(false);
	});

	it("leaves a direct package alone when it has no release on the tag", async () => {
		const plan = await createUpgradePlan(
			project(
				[
					pds("0.18.0"),
					{
						name: "@getcirrus/spaces",
						section: "dependencies",
						specifier: "^0.1.0",
						installedVersion: "0.1.0",
					},
				],
				{},
			),
			"next",
			async (input, init) => {
				const url = requestUrl(input);
				if (url.pathname === "/@getcirrus%2Fspaces/next") {
					return new Response("", { status: 404, statusText: "Not Found" });
				}
				if (url.pathname === "/@getcirrus%2Fpds/next") {
					return registry("0.19.0")(
						"https://registry.npmjs.org/@getcirrus%2Fpds/latest",
						init,
					);
				}
				return registry("0.19.0")(input, init);
			},
		);

		expect(plan.dependencies.map((change) => change.name)).toEqual([
			"@getcirrus/pds",
		]);
		expect(plan.skipped).toEqual([
			{
				name: "@getcirrus/spaces",
				specifier: "^0.1.0",
				reason: "it has no next release on npm",
			},
		]);
	});

	it("moves the direct package to the tag and keeps its specifier style", async () => {
		const plan = await createUpgradePlan(
			project([pds("0.18.0", "~0.18.0")]),
			"latest",
			registry("0.19.0"),
		);

		expect(plan.dependencies).toEqual([
			{
				name: "@getcirrus/pds",
				section: "dependencies",
				from: "~0.18.0",
				to: "~0.19.0",
				fromVersion: "0.18.0",
				toVersion: "0.19.0",
			},
		]);
	});

	it("follows the Cirrus packages installed through @getcirrus/pds", async () => {
		const plan = await createUpgradePlan(
			project([pds("0.18.0")]),
			"latest",
			registry("0.19.0"),
		);

		expect(plan.transitive).toEqual([
			{
				name: "@getcirrus/oauth-provider",
				fromVersion: "0.5.0",
				toVersion: "0.6.0",
			},
			{ name: "@getcirrus/spaces", toVersion: "0.1.0" },
		]);
		expect(plan.changelog.map((entry) => entry.body)).toEqual([
			"Add spaces.",
			"Add space scopes.",
			"Initial spaces engine.",
		]);
		expect(plan.changelog[1]?.occurrences).toEqual([
			{
				packageName: "@getcirrus/oauth-provider",
				version: "0.6.0",
				category: "minor",
			},
		]);
	});

	it("does not treat a directly declared Cirrus package as transitive", async () => {
		const plan = await createUpgradePlan(
			project([
				pds("0.18.0"),
				{
					name: "@getcirrus/oauth-provider",
					section: "dependencies",
					specifier: "0.5.0",
					installedVersion: "0.5.0",
				},
			]),
			"latest",
			async (input, init) => {
				const url = requestUrl(input);
				if (url.pathname === "/@getcirrus%2Foauth-provider/latest") {
					return jsonResponse({
						name: "@getcirrus/oauth-provider",
						version: "0.6.0",
						repository: {
							url: "git+https://github.com/ascorbic/cirrus.git",
							directory: "packages/oauth-provider",
						},
					});
				}
				return registry("0.19.0")(input, init);
			},
		);

		expect(plan.dependencies.map((change) => change.to)).toEqual([
			"^0.19.0",
			"0.6.0",
		]);
		expect(plan.transitive).toEqual([
			{ name: "@getcirrus/spaces", toVersion: "0.1.0" },
		]);
		expect(
			plan.changelog.filter((entry) => entry.body === "Add space scopes."),
		).toHaveLength(1);
	});

	it("plans nothing when the project is already on the tag", async () => {
		const requests: string[] = [];
		const plan = await createUpgradePlan(
			project([pds("0.19.0")]),
			"latest",
			registry("0.19.0", requests),
		);

		expect(plan.dependencies).toEqual([]);
		expect(plan.transitive).toEqual([]);
		expect(plan.changelog).toEqual([]);
		expect(requests).toEqual([
			"https://registry.npmjs.org/@getcirrus%2Fpds/latest",
		]);
	});

	it("reports project-managed specifiers and leaves them alone", async () => {
		const requests: string[] = [];
		const plan = await createUpgradePlan(
			project([pds("0.19.0", "workspace:*")]),
			"latest",
			registry("0.19.0", requests),
		);

		expect(plan.dependencies).toEqual([]);
		expect(plan.skipped).toEqual([
			{
				name: "@getcirrus/pds",
				specifier: "workspace:*",
				reason: "it comes from a package in this workspace, not from npm",
			},
		]);
		expect(requests).toEqual([]);
	});

	it("refuses to move to a tag older than the installed version", async () => {
		await expect(
			createUpgradePlan(project([pds("0.19.0")]), "latest", registry("0.18.0")),
		).rejects.toThrow(
			"@getcirrus/pds@latest is 0.18.0, older than the installed 0.19.0.",
		);
	});

	it("links the project template at the target release tag", async () => {
		const plan = await createUpgradePlan(
			project([pds("0.18.0")]),
			"latest",
			registry("0.19.0"),
		);

		expect(plan.referenceProject).toBe(
			"https://github.com/ascorbic/cirrus/tree/@getcirrus/pds@0.19.0/packages/create-pds/templates/pds-worker",
		);
	});

	it("lists the commands for the project's package manager and scripts", async () => {
		const plan = await createUpgradePlan(
			project([pds("0.18.0")], { deploy: "wrangler deploy" }),
			"latest",
			registry("0.19.0"),
		);

		expect(plan.guidePath).toBe("/pds/.cirrus/UPGRADE.md");
		expect(plan.commands).toEqual({
			install: "pnpm install",
			build: undefined,
			dev: undefined,
			deploy: "pnpm run deploy",
			statusDev: "pnpm exec pds status --dev",
			status: "pnpm exec pds status",
		});
	});
});
