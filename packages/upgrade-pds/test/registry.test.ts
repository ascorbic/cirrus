import { describe, expect, it } from "vitest";

import { resolveRegistryRelease } from "../src/registry.js";
import { jsonResponse, requestUrl } from "./helpers.js";

describe("resolveRegistryRelease", () => {
	it("resolves a dist-tag to a version, repository, and exact Cirrus dependencies", async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			requested.push(requestUrl(input).href);
			return jsonResponse({
				name: "@getcirrus/pds",
				version: "0.19.0",
				repository: {
					type: "git",
					url: "git+https://github.com/ascorbic/cirrus.git",
					directory: "packages/pds",
				},
				dependencies: {
					"@getcirrus/oauth-provider": "0.6.0",
					"@getcirrus/spaces": "0.1.0",
					hono: "^4.11.3",
				},
			});
		};

		const release = await resolveRegistryRelease(
			"@getcirrus/pds",
			"latest",
			fetcher,
		);

		expect(requested).toEqual([
			"https://registry.npmjs.org/@getcirrus%2Fpds/latest",
		]);
		expect(release).toEqual({
			name: "@getcirrus/pds",
			version: "0.19.0",
			repository: {
				owner: "ascorbic",
				repo: "cirrus",
				directory: "packages/pds",
			},
			cirrusDependencies: {
				"@getcirrus/oauth-provider": "0.6.0",
				"@getcirrus/spaces": "0.1.0",
			},
		});
	});

	it("ignores Cirrus dependencies that are not exact versions", async () => {
		const release = await resolveRegistryRelease(
			"@getcirrus/pds",
			"0.2.0",
			async () =>
				jsonResponse({
					name: "@getcirrus/pds",
					version: "0.2.0",
					dependencies: { "@getcirrus/oauth-provider": "workspace:*" },
				}),
		);

		expect(release.cirrusDependencies).toEqual({});
		expect(release.repository).toBeUndefined();
	});

	it("reports a tag npm does not know", async () => {
		await expect(
			resolveRegistryRelease(
				"@getcirrus/pds",
				"nope",
				async () =>
					new Response("not found", { status: 404, statusText: "Not Found" }),
			),
		).rejects.toThrow(
			"npm could not resolve @getcirrus/pds@nope (404 Not Found).",
		);
	});

	it("rejects metadata for a different package", async () => {
		await expect(
			resolveRegistryRelease("@getcirrus/pds", "latest", async () =>
				jsonResponse({ name: "other", version: "1.0.0" }),
			),
		).rejects.toThrow("npm returned invalid metadata");
	});
});
