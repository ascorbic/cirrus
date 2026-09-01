/**
 * Browser-safe checks: discovery and unauthenticated request shapes.
 *
 * These need only `fetch` — no token minting, no @atproto/space — so they
 * run in any transport including a browser bundle. Everything crypto-bound
 * lives in `../checks/full-checks.ts` behind the `./full` entry.
 */

import { defineCheck } from "../registry.js";
import { xrpcGet, xrpcPost } from "../http.js";
import { pass, fail, type Check } from "../model.js";

const SPACE_HOST_FRAGMENT = "#atproto_space_host";

const discoveryServiceEntry = defineCheck({
	id: "discovery.space-host-service",
	title: "DID document advertises the space host service endpoint",
	tier: "must",
	citations: [{ source: "proposal", ref: "0016#space-authority" }],
	needs: [],
	async run(ctx) {
		const res = await ctx.fetch(`${ctx.target.origin}/.well-known/did.json`);
		if (!res.ok) return fail(`did.json returned ${res.status}`);
		const doc = (await res.json()) as {
			service?: Array<{ id: string; type: string; serviceEndpoint: unknown }>;
		};
		const entry = (doc.service ?? []).find((s) =>
			s.id.endsWith(SPACE_HOST_FRAGMENT),
		);
		if (!entry) {
			return fail("no #atproto_space_host service entry", doc.service);
		}
		return pass(`serviceEndpoint ${String(entry.serviceEndpoint)}`, entry);
	},
});

const discoveryVerificationKey = defineCheck({
	id: "discovery.verification-key",
	title: "DID document exposes an atproto verification key",
	tier: "must",
	citations: [{ source: "proposal", ref: "0016#space-authority" }],
	needs: [],
	async run(ctx) {
		const res = await ctx.fetch(`${ctx.target.origin}/.well-known/did.json`);
		if (!res.ok) return fail(`did.json returned ${res.status}`);
		const doc = (await res.json()) as {
			verificationMethod?: Array<{ id: string }>;
		};
		// The proposal falls back to #atproto when #atproto_space is absent,
		// so at minimum #atproto must be present to verify space tokens.
		const hasAtproto = (doc.verificationMethod ?? []).some((m) =>
			m.id.endsWith("#atproto"),
		);
		return hasAtproto
			? pass("#atproto verification method present")
			: fail("no #atproto verification method", doc.verificationMethod);
	},
});

const authGetRecordRequiresAuth = defineCheck({
	id: "auth.getrecord-unauthenticated-refused",
	title: "space.getRecord refuses an unauthenticated request",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.getRecord" }],
	needs: [],
	async run(ctx) {
		// A read with no credential and no session must be refused on the
		// authentication perimeter — a conformant host checks auth before it
		// checks whether the record exists. Only 401/403 proves that: a 404
		// would also be returned by a host that serves reads with no auth at
		// all (there's simply no record at this probe URI to leak), and a 5xx
		// is a server fault, not a refusal — neither demonstrates enforcement.
		const res = await xrpcGet(ctx, "com.atproto.space.getRecord", {
			space: `at://${ctx.target.did}/space/earth.cirrus.check.space/probe`,
			repo: ctx.target.did,
			collection: "app.bsky.feed.post",
			rkey: "whatever",
		});
		if (res.status === 401 || res.status === 403) {
			return pass(`refused with ${res.status}`);
		}
		return fail(
			`unauthenticated read was not refused with 401/403 (got ${res.status} ${res.error ?? ""})`,
			res.json,
		);
	},
});

const authCredentialRequiresToken = defineCheck({
	id: "auth.getspacecredential-untoken-refused",
	title: "space.getSpaceCredential refuses a request with no delegation token",
	tier: "must",
	citations: [
		{ source: "lexicon", ref: "com.atproto.space.getSpaceCredential" },
	],
	needs: [],
	async run(ctx) {
		const res = await xrpcPost(ctx, "com.atproto.space.getSpaceCredential", {
			space: `at://${ctx.target.did}/space/earth.cirrus.check.space/probe`,
		});
		if (res.status === 401 || res.status === 403 || res.status === 400) {
			return pass(`refused with ${res.status} ${res.error ?? ""}`);
		}
		return fail(
			`unexpected ${res.status} for a tokenless credential request`,
			res.json,
		);
	},
});

const requestInvalidSpaceUri = defineCheck({
	id: "request.invalid-space-uri-rejected",
	title: "A malformed space reference is rejected, not misread",
	tier: "must",
	citations: [{ source: "lexicon", ref: "com.atproto.space.getLatestCommit" }],
	needs: [],
	async run(ctx) {
		const res = await xrpcGet(ctx, "com.atproto.space.getLatestCommit", {
			space: "not-a-space-uri",
			repo: ctx.target.did,
		});
		if (res.status >= 400 && res.status < 500) {
			return pass(`rejected with ${res.status} ${res.error ?? ""}`);
		}
		return fail(
			`did not reject a malformed space uri (${res.status})`,
			res.json,
		);
	},
});

/** Checks that need no crypto and no session — safe in any transport. */
export const baseChecks: Check[] = [
	discoveryServiceEntry,
	discoveryVerificationKey,
	authGetRecordRequiresAuth,
	authCredentialRequiresToken,
	requestInvalidSpaceUri,
];
