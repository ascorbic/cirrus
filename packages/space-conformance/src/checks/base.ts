/**
 * Browser-safe checks that need no session: discovery and unauthenticated
 * request shapes. They need only `fetch` — no token minting, no
 * @atproto/space — so they run in any transport, including a browser
 * bundle, against any host the user names.
 */

import { defineCheck } from "../registry.js";
import { xrpcGet, xrpcPost } from "../http.js";
import { pass, fail, type Check, type CheckContext } from "../model.js";
import {
	resolveDidDocument,
	serviceEndpoint,
	verificationMethodDidKey,
	type DidDocument,
} from "../did.js";
import { createCredentialKey, isP256DidKey } from "../space-auth.js";
import { PROBE_TYPE, describe, unknownSpaceUri } from "./probe.js";

const changeset = (ref: string) => ({ source: "changeset" as const, ref });
const lexicon = (ref: string) => ({ source: "lexicon" as const, ref });

/** The target's DID document, resolved once per run by its DID method. */
async function targetDoc(ctx: CheckContext): Promise<DidDocument> {
	const cached = ctx.state.get("did.doc.target");
	if (cached) return cached as DidDocument;
	const doc = await resolveDidDocument(ctx, ctx.target.did);
	ctx.state.set("did.doc.target", doc);
	return doc;
}

const sameOrigin = (a: string, b: string) => {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
};

const discoveryPdsService = defineCheck({
	id: "discovery.pds-service",
	title: "The authority's #atproto_pds service is the space host",
	tier: "must",
	citations: [changeset("plain-keys-resolve")],
	needs: [],
	async run(ctx) {
		// The alpha dropped #atproto_space_host: a space authority is resolved
		// like any account, and its PDS is its space host. So the target DID
		// must route to this origin through #atproto_pds.
		const doc = await targetDoc(ctx);
		const endpoint = serviceEndpoint(doc, "atproto_pds");
		if (!endpoint) return fail("no #atproto_pds service entry", doc.service);
		return sameOrigin(endpoint, ctx.target.origin)
			? pass(`#atproto_pds is ${endpoint}`)
			: fail(
					`#atproto_pds is ${endpoint}, not the target origin ${ctx.target.origin}`,
					doc.service,
				);
	},
});

const discoverySigningKey = defineCheck({
	id: "discovery.signing-key",
	title: "The DID document exposes the #atproto key that signs space tokens",
	tier: "must",
	citations: [changeset("plain-keys-resolve")],
	needs: [],
	async run(ctx) {
		const doc = await targetDoc(ctx);
		const key = verificationMethodDidKey(doc, "atproto");
		return key
			? pass(`#atproto is ${key}`)
			: fail("no usable #atproto verification method", doc.verificationMethod);
	},
});

const discoveryKemKey = defineCheck({
	id: "discovery.kem-key",
	title: "The DID document publishes a P-256 #atproto_kem key",
	tier: "must",
	citations: [
		changeset("quiet-spaces-mac"),
		lexicon("com.atproto.space.getLatestCommit"),
	],
	needs: [],
	async run(ctx) {
		// A syncer derives each request's MAC secret by ECDH against the
		// repo's #atproto_kem key. Without it no credentialed read of this
		// account's repos can be authenticated at all.
		const doc = await targetDoc(ctx);
		const key = verificationMethodDidKey(doc, "atproto_kem");
		if (!key) return fail("no #atproto_kem verification method", doc.verificationMethod);
		return isP256DidKey(key)
			? pass(`#atproto_kem is ${key}`)
			: fail(`#atproto_kem is not a P-256 key: ${key}`);
	},
});

const discoveryLegacyEntries = defineCheck({
	id: "discovery.legacy-space-entries",
	title: "Reports any pre-alpha #atproto_space / #atproto_space_host entries",
	tier: "info",
	citations: [changeset("plain-keys-resolve")],
	needs: [],
	async run(ctx) {
		const doc = await targetDoc(ctx);
		const legacy = [
			...(doc.verificationMethod ?? []).map((m) => m.id),
			...(doc.service ?? []).map((s) => s.id),
		].filter((id) => /#atproto_space(_host)?$/.test(id));
		return pass(
			legacy.length
				? `still publishes ${legacy.join(", ")} (ignored by the alpha)`
				: "no legacy space entries",
		);
	},
});

const authGetRecordRequiresAuth = defineCheck({
	id: "auth.getrecord-unauthenticated-refused",
	title: "space.getRecord refuses an unauthenticated request",
	tier: "must",
	citations: [lexicon("com.atproto.space.getRecord")],
	needs: [],
	async run(ctx) {
		// A read with no credential and no session must be refused on the
		// authentication perimeter — a conformant host checks auth before it
		// checks whether the record exists. Only 401/403 proves that: a 404
		// would also be returned by a host that serves reads with no auth at
		// all (there's simply no record at this probe URI to leak), and a 5xx
		// is a server fault, not a refusal — neither demonstrates enforcement.
		const res = await xrpcGet(ctx, "com.atproto.space.getRecord", {
			space: `at://${ctx.target.did}/space/${PROBE_TYPE}/probe`,
			repo: ctx.target.did,
			collection: "app.bsky.feed.post",
			rkey: "whatever",
		});
		if (res.status === 401 || res.status === 403) {
			return pass(`refused with ${res.status}`);
		}
		return fail(
			`unauthenticated read was not refused with 401/403 (got ${describe(res)})`,
			res.json,
		);
	},
});

const credentialTokenlessUnknown = defineCheck({
	id: "credential.tokenless-unknown-space",
	title: "A tokenless credential request for an unknown space gets SpaceNotFound",
	tier: "must",
	citations: [lexicon("com.atproto.space.getSpaceCredential@error:SpaceNotFound")],
	needs: [],
	async run(ctx) {
		// No delegation token, a space nobody created: there is nothing public
		// to issue for, and the declared answer is SpaceNotFound — the same
		// answer a non-public space gives, so existence is not disclosed.
		const key = await createCredentialKey();
		const res = await xrpcPost(ctx, "com.atproto.space.getSpaceCredential", {
			space: unknownSpaceUri(ctx.target.did),
			credentialKid: key.did,
		});
		if (res.status === 200) return fail("issued a credential for an unknown space");
		return res.error === "SpaceNotFound"
			? pass("refused with SpaceNotFound")
			: fail(`refused with ${describe(res)}, expected SpaceNotFound`, res.json);
	},
});

const requestInvalidSpaceUri = defineCheck({
	id: "request.invalid-space-uri-rejected",
	title: "A malformed space reference is rejected, not misread",
	tier: "must",
	citations: [lexicon("com.atproto.space.getLatestCommit")],
	needs: [],
	async run(ctx) {
		const res = await xrpcGet(ctx, "com.atproto.space.getLatestCommit", {
			space: "not-a-space-uri",
			repo: ctx.target.did,
		});
		if (res.status >= 400 && res.status < 500) {
			return pass(`rejected with ${describe(res)}`);
		}
		return fail(`did not reject a malformed space uri (${res.status})`, res.json);
	},
});

/** Checks that need no crypto and no session — safe in any transport. */
export const baseChecks: Check[] = [
	discoveryPdsService,
	discoverySigningKey,
	discoveryKemKey,
	discoveryLegacyEntries,
	authGetRecordRequiresAuth,
	credentialTokenlessUnknown,
	requestInvalidSpaceUri,
];
