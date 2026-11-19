import { describe, expect, it } from "vitest";
import { withHandle } from "../src/plc";

describe("withHandle", () => {
	it("replaces the first at:// entry and keeps other entries", () => {
		expect(
			withHandle(
				["at://old.bsky.social", "https://example.com/me"],
				"new.example.com",
			),
		).toEqual(["at://new.example.com", "https://example.com/me"]);
	});

	it("adds the handle first when there is no at:// entry", () => {
		expect(withHandle(["https://example.com/me"], "new.example.com")).toEqual([
			"at://new.example.com",
			"https://example.com/me",
		]);
		expect(withHandle([], "new.example.com")).toEqual(["at://new.example.com"]);
	});

	it("drops a later copy of the handle", () => {
		expect(
			withHandle(
				["at://old.bsky.social", "at://new.example.com"],
				"new.example.com",
			),
		).toEqual(["at://new.example.com"]);
	});

	it("keeps later at:// entries that aren't the handle", () => {
		expect(
			withHandle(
				["at://old.bsky.social", "at://alias.example.com"],
				"new.example.com",
			),
		).toEqual(["at://new.example.com", "at://alias.example.com"]);
	});

	it("leaves the list unchanged when the handle is already first", () => {
		const current = ["at://new.example.com", "https://example.com/me"];
		expect(withHandle(current, "new.example.com")).toEqual(current);
	});
});
