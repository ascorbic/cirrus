import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	deduplicateChangelog,
	entriesBetween,
	fetchChangelogRange,
	parseChangelog,
} from "../src/changelog.js";
import { requestUrl } from "./helpers.js";

const CHANGELOG = `# @getcirrus/pds

## 0.19.0

### Minor Changes

- [#219](https://github.com/ascorbic/cirrus/pull/219) [\`5762e22\`](https://github.com/ascorbic/cirrus/commit/5762e22a) Thanks [@ascorbic](https://github.com/ascorbic)! - Add spaces.

  Add these bindings:

  - \`SPACES\`
  - \`SPACES_INDEX\`

### Patch Changes

- Updated dependencies [[\`5762e22\`](https://github.com/ascorbic/cirrus/commit/5762e22a)]:
  - @getcirrus/oauth-provider@0.6.0

## 0.19.0-next.1

### Patch Changes

- Prerelease fix.

## 0.18.0

### Minor Changes

- [\`c560f2e\`](https://github.com/ascorbic/cirrus/commit/c560f2e6) Thanks [@ascorbic](https://github.com/ascorbic)! - Proxy reports.

### Patch Changes

- Hand-written entry.

## 0.17.1

### Patch Changes

- Older fix.
`;

const repository = {
	owner: "ascorbic",
	repo: "cirrus",
	directory: "packages/pds",
};

describe("parseChangelog", () => {
	it("strips the Changesets attribution and keeps the whole authored body", () => {
		const [spaces] = parseChangelog(CHANGELOG);

		expect(spaces).toEqual({
			version: "0.19.0",
			category: "minor",
			body: "Add spaces.\n\n  Add these bindings:\n\n  - `SPACES`\n  - `SPACES_INDEX`",
			source: "[#219](https://github.com/ascorbic/cirrus/pull/219)",
		});
	});

	it("drops generated dependency-bump entries", () => {
		expect(
			parseChangelog(CHANGELOG).some((entry) =>
				entry.body.includes("Updated dependencies"),
			),
		).toBe(false);
	});

	it("uses the commit as the source when there is no pull request", () => {
		const proxy = parseChangelog(CHANGELOG).find(
			(entry) => entry.body === "Proxy reports.",
		);

		expect(proxy?.source).toBe(
			"[`c560f2e`](https://github.com/ascorbic/cirrus/commit/c560f2e6)",
		);
	});
});

describe("entriesBetween", () => {
	it("returns entries after the installed version up to the target", () => {
		expect(
			entriesBetween(CHANGELOG, "0.17.1", "0.19.0").map((entry) => entry.body),
		).toEqual([
			expect.stringContaining("Add spaces."),
			"Proxy reports.",
			"Hand-written entry.",
		]);
	});

	it("includes prereleases only when the target is one", () => {
		expect(
			entriesBetween(CHANGELOG, "0.18.0", "0.19.0-next.1").map(
				(entry) => entry.body,
			),
		).toEqual(["Prerelease fix."]);
	});

	it("returns the whole history up to the target for a package that was not installed", () => {
		expect(
			entriesBetween(CHANGELOG, undefined, "0.18.0").map(
				(entry) => entry.version,
			),
		).toEqual(["0.18.0", "0.18.0", "0.17.1"]);
	});

	it("reads the published @getcirrus/pds changelog", async () => {
		const published = await readFile(
			new URL("../../pds/CHANGELOG.md", import.meta.url),
			"utf8",
		);

		const entries = entriesBetween(published, "0.17.1", "0.19.0");

		expect(new Set(entries.map((entry) => entry.version))).toEqual(
			new Set(["0.18.0", "0.19.0"]),
		);
		expect(entries.find((entry) => entry.version === "0.19.0")).toMatchObject({
			category: "minor",
			source: "[#219](https://github.com/ascorbic/cirrus/pull/219)",
			body: expect.stringMatching(/^Atproto spaces \(alpha\)/),
		});
		expect(entries.every((entry) => !entry.body.startsWith("- "))).toBe(true);
	});
});

describe("fetchChangelogRange", () => {
	it("fetches the changelog from the target release tag", async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			requested.push(requestUrl(input).href);
			return new Response(CHANGELOG);
		};

		const entries = await fetchChangelogRange(
			repository,
			"@getcirrus/pds",
			"0.18.0",
			"0.19.0",
			fetcher,
		);

		expect(requested).toEqual([
			"https://raw.githubusercontent.com/ascorbic/cirrus/refs/tags/%40getcirrus%2Fpds%400.19.0/packages/pds/CHANGELOG.md",
		]);
		expect(entries).toEqual([
			{
				body: expect.stringContaining("Add spaces."),
				occurrences: [
					{
						packageName: "@getcirrus/pds",
						version: "0.19.0",
						category: "minor",
						source: "[#219](https://github.com/ascorbic/cirrus/pull/219)",
					},
				],
			},
		]);
	});

	it("reports a changelog GitHub cannot serve", async () => {
		await expect(
			fetchChangelogRange(
				repository,
				"@getcirrus/pds",
				"0.18.0",
				"0.19.0",
				async () => new Response("", { status: 404, statusText: "Not Found" }),
			),
		).rejects.toThrow(
			"GitHub could not fetch ascorbic/cirrus/packages/pds/CHANGELOG.md at @getcirrus/pds@0.19.0 (404 Not Found).",
		);
	});
});

describe("deduplicateChangelog", () => {
	it("merges an entry repeated across packages without shortening it", () => {
		const occurrence = (packageName: string) => ({
			packageName,
			version: "0.6.0",
			category: "minor" as const,
		});

		expect(
			deduplicateChangelog([
				{ body: "Shared change.", occurrence: occurrence("@getcirrus/pds") },
				{ body: "Other change.", occurrence: occurrence("@getcirrus/pds") },
				{ body: "Shared change.", occurrence: occurrence("@getcirrus/spaces") },
			]),
		).toEqual([
			{
				body: "Shared change.",
				occurrences: [
					occurrence("@getcirrus/pds"),
					occurrence("@getcirrus/spaces"),
				],
			},
			{ body: "Other change.", occurrences: [occurrence("@getcirrus/pds")] },
		]);
	});
});
