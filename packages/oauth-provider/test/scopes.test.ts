import { describe, expect, it } from "vitest";
import {
	ATPROTO_SCOPE,
	ScopeMissingError,
	ScopeParseError,
	parseScope,
	permissionsFor,
} from "../src/scopes.js";

describe("parseScope", () => {
	it("accepts the bare atproto scope", () => {
		const set = parseScope("atproto");
		expect(set.has("atproto")).toBe(true);
	});

	it("requires the atproto scope to be present", () => {
		expect(() => parseScope("")).toThrow(ScopeParseError);
		expect(() => parseScope("transition:generic")).toThrow(ScopeParseError);
	});

	it("accepts transitional scopes alongside atproto", () => {
		const set = parseScope("atproto transition:generic transition:chat.bsky");
		expect(set.size).toBe(3);
	});

	it("accepts granular repo scopes", () => {
		const set = parseScope(
			"atproto repo:app.bsky.feed.post repo:*?action=delete",
		);
		expect(set.has("repo:app.bsky.feed.post")).toBe(true);
		expect(set.has("repo:*?action=delete")).toBe(true);
	});

	it("accepts granular rpc scopes with audience", () => {
		const set = parseScope(
			"atproto rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview",
		);
		expect(set.size).toBe(2);
	});

	it("accepts blob, account, identity scopes", () => {
		const set = parseScope(
			"atproto blob:image/* account:email?action=manage identity:handle",
		);
		expect(set.size).toBe(4);
	});

	it("rejects malformed granular scopes", () => {
		expect(() => parseScope("atproto repo:not a real nsid")).toThrow(
			ScopeParseError,
		);
		expect(() =>
			parseScope("atproto rpc:app.bsky.feed.getTimeline"), // missing aud
		).toThrow(ScopeParseError);
	});

	it("rejects unknown resources", () => {
		expect(() => parseScope("atproto madeup:thing")).toThrow(ScopeParseError);
	});

	it("rejects include: scopes (Phase 1)", () => {
		expect(() =>
			parseScope("atproto include:com.example.basic?aud=did:web:foo%23svc"),
		).toThrow(/Permission sets are not yet supported/);
	});
});

describe("permissionsFor", () => {
	it("allowsRepo for an explicit collection scope", () => {
		const perms = permissionsFor("atproto repo:app.bsky.feed.post");
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.post", action: "create" }),
		).toBe(true);
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.post", action: "delete" }),
		).toBe(true);
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.like", action: "create" }),
		).toBe(false);
	});

	it("scopes the action when ?action= is given", () => {
		const perms = permissionsFor("atproto repo:app.bsky.feed.post?action=create");
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.post", action: "create" }),
		).toBe(true);
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.post", action: "delete" }),
		).toBe(false);
	});

	it("treats transition:generic as a catch-all for repo and blob", () => {
		const perms = permissionsFor("atproto transition:generic");
		expect(
			perms.allowsRepo({ collection: "app.bsky.feed.post", action: "create" }),
		).toBe(true);
		expect(perms.allowsBlob({ mime: "image/png" })).toBe(true);
	});

	it("transition:generic does NOT grant account perms", () => {
		const perms = permissionsFor("atproto transition:generic");
		expect(
			perms.allowsAccount({ attr: "email", action: "manage" }),
		).toBe(false);
	});

	it("transition:email grants account:email", () => {
		const perms = permissionsFor(
			"atproto transition:generic transition:email",
		);
		expect(
			perms.allowsAccount({ attr: "email", action: "read" }),
		).toBe(true);
	});

	it("assertRepo throws ScopeMissingError when not granted", () => {
		const perms = permissionsFor("atproto repo:app.bsky.feed.post");
		expect(() =>
			perms.assertRepo({
				collection: "app.bsky.feed.like",
				action: "create",
			}),
		).toThrow(ScopeMissingError);
	});
});

describe("ATPROTO_SCOPE", () => {
	it("is the literal 'atproto'", () => {
		expect(ATPROTO_SCOPE).toBe("atproto");
	});
});
