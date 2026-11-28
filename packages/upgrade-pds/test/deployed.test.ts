import { describe, expect, it } from "vitest";

import { fetchDeployedVersion } from "../src/deployed.js";
import { jsonResponse, requestUrl } from "./helpers.js";

describe("fetchDeployedVersion", () => {
	it("reads the version from the health endpoint", async () => {
		const requested: string[] = [];

		const version = await fetchDeployedVersion(
			"pds.example.com",
			async (input) => {
				requested.push(requestUrl(input).href);
				return jsonResponse({ status: "ok", version: "cirrus 0.17.1" });
			},
		);

		expect(requested).toEqual(["https://pds.example.com/xrpc/_health"]);
		expect(version).toBe("0.17.1");
	});

	it("accepts a bare version from older releases", async () => {
		expect(
			await fetchDeployedVersion("pds.example.com", async () =>
				jsonResponse({ version: "0.9.0" }),
			),
		).toBe("0.9.0");
	});

	it("returns nothing when the PDS cannot be reached or does not say", async () => {
		const failures: (typeof fetch)[] = [
			async () => new Response("", { status: 503 }),
			async () => new Response("not json"),
			async () => jsonResponse({ status: "ok" }),
			async () => jsonResponse({ version: "something else" }),
			async () => {
				throw new TypeError("fetch failed");
			},
		];

		for (const fetcher of failures) {
			expect(
				await fetchDeployedVersion("pds.example.com", fetcher),
			).toBeUndefined();
		}
	});
});
