import { describe, expect, it } from "vitest";
import type { LexiconPermissionSet } from "../src/permission-sets.js";
import {
	ATPROTO_SCOPE,
	ScopeMissingError,
	ScopeParseError,
	expandScope,
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

	it("rejects include: scopes by default (strict mode)", () => {
		expect(() =>
			parseScope("atproto include:com.example.basic?aud=did:web:foo%23svc"),
		).toThrow(/Permission sets cannot be requested/);
	});

	it("accepts include: scopes when allowIncludes is true", () => {
		const set = parseScope(
			"atproto include:com.example.basic?aud=did:web:foo%23svc",
			{ allowIncludes: true },
		);
		expect(set.size).toBe(2);
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

describe("renderConsentUI scope grouping", () => {
	it("collapses many repo: scopes sharing an authority into a disclosure", async () => {
		const { renderConsentUI } = await import("../src/ui.js");
		// Subset of Tangled's actual scope list — 6 sh.tangled.* repo scopes.
		const scope = [
			"atproto",
			"repo:sh.tangled.actor.profile",
			"repo:sh.tangled.feed.reaction",
			"repo:sh.tangled.feed.star",
			"repo:sh.tangled.graph.follow",
			"repo:sh.tangled.knot",
			"repo:sh.tangled.repo",
		].join(" ");

		const html = renderConsentUI({
			client: {
				clientId: "did:web:tangled.example",
				clientName: "Tangled",
				redirectUris: ["https://tangled.example/cb"],
			},
			scope,
			authorizeUrl: "/oauth/authorize",
			state: "s",
			oauthParams: {},
		});

		expect(html).toContain(
			"Write records under sh.tangled.* in your repository (6 record types)",
		);
		expect(html).toContain("<details>");
		// Per-NSID detail still present, just inside the disclosure.
		expect(html).toContain("sh.tangled.actor.profile");
		// Verbose per-row template should NOT be repeated 6 times.
		const matches = html.match(/Write records \(create, update, delete\) for/g);
		expect(matches).toBeNull();
	});

	it("groups rpc: scopes by audience and collapses ≥3", async () => {
		const { renderConsentUI } = await import("../src/ui.js");
		const scope = [
			"atproto",
			"rpc:sh.tangled.repo.create?aud=*",
			"rpc:sh.tangled.repo.delete?aud=*",
			"rpc:sh.tangled.repo.merge?aud=*",
			"rpc:sh.tangled.repo.fork?aud=*",
		].join(" ");
		const html = renderConsentUI({
			client: {
				clientId: "did:web:tangled.example",
				clientName: "Tangled",
				redirectUris: ["https://tangled.example/cb"],
			},
			scope,
			authorizeUrl: "/oauth/authorize",
			state: "s",
			oauthParams: {},
		});

		expect(html).toContain("API methods on any service");
		expect(html).toContain("<details>");
	});

	it("renders ≤2 repo: scopes inline rather than collapsing", async () => {
		const { renderConsentUI } = await import("../src/ui.js");
		const html = renderConsentUI({
			client: {
				clientId: "did:web:client.example.com",
				clientName: "Test Client",
				redirectUris: ["https://client.example.com/cb"],
			},
			scope: "atproto repo:app.bsky.feed.post repo:app.bsky.feed.like",
			authorizeUrl: "/oauth/authorize",
			state: "s",
			oauthParams: {},
		});
		expect(html).toContain("for app.bsky.feed.post");
		expect(html).toContain("for app.bsky.feed.like");
		expect(html).not.toContain("<details>");
	});
});

describe("renderConsentUI bundle metadata", () => {
	it("shows the bundle title for include: scopes when provided", async () => {
		const { renderConsentUI } = await import("../src/ui.js");
		const html = renderConsentUI({
			client: {
				clientId: "did:web:client.example.com",
				clientName: "Test Client",
				redirectUris: ["https://client.example.com/cb"],
			},
			scope: "atproto include:com.example.basic?aud=did:web:foo%23svc",
			authorizeUrl: "/oauth/authorize",
			state: "s",
			oauthParams: {},
			bundles: [
				{ nsid: "com.example.basic", title: "Basic App Functionality" },
			],
		});
		expect(html).toContain("Basic App Functionality");
		expect(html).not.toContain("Permissions from com.example.basic");
	});

	it("falls back to NSID when no bundle metadata is provided", async () => {
		const { renderConsentUI } = await import("../src/ui.js");
		const html = renderConsentUI({
			client: {
				clientId: "did:web:client.example.com",
				clientName: "Test Client",
				redirectUris: ["https://client.example.com/cb"],
			},
			scope: "atproto include:com.example.basic?aud=did:web:foo%23svc",
			authorizeUrl: "/oauth/authorize",
			state: "s",
			oauthParams: {},
		});
		expect(html).toContain("Permissions from com.example.basic");
	});
});

describe("expandScope", () => {
	const basicSet: LexiconPermissionSet = {
		type: "permission-set",
		title: "Basic",
		permissions: [
			{
				type: "permission",
				resource: "repo",
				collection: ["com.example.post"],
			},
			{
				type: "permission",
				resource: "rpc",
				lxm: ["com.example.feed.getTimeline"],
				inheritAud: true,
			},
		],
	};

	function mockResolver(map: Record<string, LexiconPermissionSet | null>) {
		return {
			resolve: async (nsid: string) =>
				nsid in map ? (map[nsid] ?? null) : null,
		};
	}

	it("passes through scopes that have no include:", async () => {
		const out = await expandScope(
			"atproto repo:app.bsky.feed.post",
			mockResolver({}),
		);
		expect(out.split(" ").sort()).toEqual([
			"atproto",
			"repo:app.bsky.feed.post",
		]);
	});

	it("expands an include: into its bundled permissions", async () => {
		const out = await expandScope(
			"atproto include:com.example.basic?aud=did:web:foo%23svc",
			mockResolver({ "com.example.basic": basicSet }),
		);
		const parts = out.split(" ").sort();
		expect(parts).toContain("atproto");
		expect(parts).toContain("repo:com.example.post");
		// inheritAud=true means the rpc permission should pick up the
		// include's aud parameter (did:web:foo#svc), which the spec serialises
		// as percent-encoded `%23` for the fragment separator.
		expect(
			parts.some(
				(s) =>
					s.startsWith("rpc:com.example.feed.getTimeline") &&
					/did:web:foo(?:#|%23)svc/.test(s),
			),
		).toBe(true);
	});

	it("throws when the include cannot be resolved", async () => {
		await expect(
			expandScope(
				"atproto include:com.example.unknown?aud=did:web:foo%23svc",
				mockResolver({}),
			),
		).rejects.toThrow(ScopeParseError);
	});

	it("throws when no resolver is configured but include: is present", async () => {
		await expect(
			expandScope(
				"atproto include:com.example.basic?aud=did:web:foo%23svc",
				undefined,
			),
		).rejects.toThrow(/no resolver configured/);
	});
});
