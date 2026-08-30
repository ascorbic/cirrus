import { describe, expect, it } from "vitest";
import {
	ScopeParseError,
	finalizeSpaceScopes,
	parseScope,
	parseSpaceScope,
	permissionsFor,
} from "../src/scopes.js";

describe("parseScope with space scopes", () => {
	it("rejects space scopes by default", () => {
		expect(() => parseScope("atproto space:app.bsky.group")).toThrow(
			ScopeParseError,
		);
		expect(() => parseScope("atproto space:app.bsky.group")).toThrow(
			/not enabled/,
		);
	});

	it("rejects the named-param space form by default too", () => {
		expect(() =>
			parseScope("atproto space?type=app.bsky.group"),
		).toThrow(/not enabled/);
	});

	it("accepts valid space scopes when enabled", () => {
		const set = parseScope("atproto space:app.bsky.group", {
			allowSpaceScopes: true,
		});
		expect(set.has("space:app.bsky.group")).toBe(true);
	});

	it("accepts parameterised space scopes when enabled", () => {
		const set = parseScope(
			"atproto space:app.bsky.group?authority=did:plc:abc123&skey=3kbcq3p7ad400",
			{ allowSpaceScopes: true },
		);
		expect(set.size).toBe(2);
	});

	it("rejects malformed space scopes even when enabled", () => {
		// Positional type is required
		expect(() => parseScope("atproto space", { allowSpaceScopes: true })).toThrow(
			ScopeParseError,
		);
		expect(() =>
			parseScope("atproto space:app.bsky.group?bogus=1", {
				allowSpaceScopes: true,
			}),
		).toThrow(ScopeParseError);
	});
});

describe("parseSpaceScope", () => {
	it("parses positional and named-param forms", () => {
		expect(parseSpaceScope("space:app.bsky.group")?.type).toBe(
			"app.bsky.group",
		);
		expect(parseSpaceScope("space?type=app.bsky.group")?.type).toBe(
			"app.bsky.group",
		);
	});

	it("returns null for non-space tokens", () => {
		expect(parseSpaceScope("repo:app.bsky.feed.post")).toBeNull();
		expect(parseSpaceScope("spaces:nope")).toBeNull();
	});
});

describe("finalizeSpaceScopes", () => {
	const did = "did:web:alice.test";

	it("resolves authority=self to the user's DID", async () => {
		const scope = await finalizeSpaceScopes("atproto space:app.bsky.group", {
			userDid: did,
		});
		expect(scope).toContain(`authority=${did}`);
		expect(scope).not.toContain("self");
	});

	it("leaves explicit authorities untouched", async () => {
		const input =
			"atproto space:app.bsky.group?authority=did:plc:abc123";
		const scope = await finalizeSpaceScopes(input, { userDid: did });
		expect(scope).toContain("authority=did:plc:abc123");
		expect(scope).not.toContain(did);
	});

	it("does not touch non-space scopes", async () => {
		const input = "atproto repo:app.bsky.feed.post blob:image/*";
		expect(await finalizeSpaceScopes(input, { userDid: did })).toBe(input);
	});

	it("applies default collections from the space type declaration", async () => {
		const scope = await finalizeSpaceScopes("atproto space:app.bsky.group", {
			userDid: did,
			resolveSpaceCollections: async (nsid) => {
				expect(nsid).toBe("app.bsky.group");
				return ["app.bsky.feed.post", "app.bsky.feed.like"];
			},
		});
		expect(scope).toContain("collection=app.bsky.feed.like");
		expect(scope).toContain("collection=app.bsky.feed.post");
	});

	it("keeps explicitly requested collections instead of defaults", async () => {
		const scope = await finalizeSpaceScopes(
			"atproto space:app.bsky.group?collection=app.bsky.feed.post",
			{
				userDid: did,
				resolveSpaceCollections: async () => ["some.other.collection"],
			},
		);
		expect(scope).toContain("collection=app.bsky.feed.post");
		expect(scope).not.toContain("some.other.collection");
	});

	it("survives a failing collection resolver", async () => {
		const scope = await finalizeSpaceScopes("atproto space:app.bsky.group", {
			userDid: did,
			resolveSpaceCollections: async () => {
				throw new Error("network down");
			},
		});
		expect(scope).toContain(`authority=${did}`);
	});
});

describe("space permission checks", () => {
	it("grants match after self-resolution", async () => {
		const did = "did:web:alice.test";
		const stored = await finalizeSpaceScopes(
			"atproto space:app.bsky.group",
			{
				userDid: did,
				resolveSpaceCollections: async () => ["app.bsky.feed.post"],
			},
		);
		const perms = permissionsFor(stored);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: did,
				skey: "3kbcq3p7ad400",
				action: "read",
			}),
		).toBe(true);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: did,
				skey: "3kbcq3p7ad400",
				action: "create",
				collection: "app.bsky.feed.post",
			}),
		).toBe(true);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: did,
				skey: "3kbcq3p7ad400",
				action: "create",
				collection: "app.bsky.other.collection",
			}),
		).toBe(false);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: "did:plc:someoneelse",
				skey: "3kbcq3p7ad400",
				action: "read",
			}),
		).toBe(false);
	});

	it("transition:generic grants nothing on spaces", () => {
		const perms = permissionsFor("atproto transition:generic");
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: "did:web:alice.test",
				skey: "*",
				action: "read",
			}),
		).toBe(false);
	});

	it("manage ops gate on the manage axis", async () => {
		const did = "did:web:alice.test";
		const stored = await finalizeSpaceScopes(
			"atproto space:app.bsky.group?manage=create&manage=delete",
			{ userDid: did },
		);
		const perms = permissionsFor(stored);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: did,
				skey: "*",
				manage: "create",
			}),
		).toBe(true);
		expect(
			perms.allowsSpace({
				type: "app.bsky.group",
				authority: did,
				skey: "*",
				manage: "update",
			}),
		).toBe(false);
	});
});
