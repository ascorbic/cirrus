import { describe, expect, it } from "vitest";

import { validateOptions } from "../src/args.js";

describe("validateOptions", () => {
	it("accepts npm dist-tags", () => {
		for (const tag of ["latest", "next", "beta", "spaces-alpha"]) {
			expect(() =>
				validateOptions({ tag, json: false, yes: false }),
			).not.toThrow();
		}
	});

	it("rejects versions and ranges", () => {
		for (const tag of ["0.19.0", "^0.19.0", "v1", "1.x", ""]) {
			expect(() => validateOptions({ tag, json: false, yes: false })).toThrow(
				"--to accepts an npm dist-tag",
			);
		}
	});

	it("rejects --json with --yes", () => {
		expect(() =>
			validateOptions({ tag: "latest", json: true, yes: true }),
		).toThrow("--json reports the plan without applying it");
	});

	it("accepts an exact version for --from and nothing else", () => {
		const options = { tag: "latest", json: false, yes: false };
		expect(() => validateOptions({ ...options, from: "0.18.0" })).not.toThrow();
		for (const from of ["latest", "^0.18.0", "0.18", ""]) {
			expect(() => validateOptions({ ...options, from })).toThrow(
				"--from takes the exact @getcirrus/pds version",
			);
		}
	});
});
