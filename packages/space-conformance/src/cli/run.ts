/**
 * The CLI's core: resolve a target, assemble a context from what the
 * invocation can provide, run the catalog. Exported separately from the
 * bin so it can be driven in tests against an injected fetch without
 * spawning a process.
 */

import { filterCatalog } from "../registry.js";
import { runChecks, type RunReport } from "../runner.js";
import { fullCatalog } from "../full.js";
import { KeypairIdentityProvider } from "../identity.js";
import type { Capability, CheckContext, Tier } from "../model.js";

/** The alpha build the suite's verifiers are pinned to (from our deps). */
const ALPHA_BUILD = "0.0.0-spaces-alpha-20260818163953";

export interface RunConformanceOptions {
	origin: string;
	/** Target DID; resolved from the origin's did.json when omitted. */
	did?: string;
	implementation?: string;
	/** Operator bearer token; enables the operator capability when present. */
	operatorToken?: string;
	/**
	 * Mint the operator token by signing in: `com.atproto.server.createSession`
	 * with this handle and {@link password}. Works against any standard PDS —
	 * unlike a deployment-specific static token. Ignored when
	 * {@link operatorToken} is set.
	 */
	handle?: string;
	/**
	 * The account password for {@link handle}. The bin only ever sources this
	 * from the environment (`SPACE_CONFORMANCE_PASSWORD`) — never argv, which
	 * leaks into shell history and process listings. Use the main password:
	 * app passwords are refused on space routes.
	 */
	password?: string;
	/**
	 * An authenticated fetch for operator calls — a DPoP-bound OAuth session
	 * from the loopback sign-in, which must sign each request individually
	 * and so cannot be expressed as a bearer header. Takes precedence over
	 * {@link operatorToken} and {@link handle}.
	 */
	operatorFetch?: typeof fetch;
	/**
	 * The target is a standalone space host rather than a full PDS: withhold
	 * the `pds-blobs` and `pds-delegation` capabilities so the checks needing
	 * `repo.uploadBlob` / `getDelegationToken` skip instead of false-failing.
	 */
	standaloneHost?: boolean;
	/**
	 * Provide harness identities. Only meaningful when the target can
	 * resolve them — either an in-process fixture wired to the provider, or
	 * a live deployment publishing the DIDs. A bare CLI against a remote
	 * host cannot, so identity-requiring checks skip by default.
	 */
	identities?: boolean;
	tiers?: Tier[];
	destructive?: boolean;
	slow?: boolean;
	suiteVersion: string;
	/** Injectable for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
}

export async function runConformance(
	options: RunConformanceOptions,
): Promise<RunReport> {
	const doFetch = options.fetch ?? fetch;
	// A trailing slash on --target would otherwise produce a double slash in
	// the DID-document URL, which some hosts 404.
	const origin = options.origin.replace(/\/+$/, "");
	const did = options.did ?? (await resolveDid(doFetch, origin));

	let operatorToken = options.operatorToken;
	if (!operatorToken && !options.operatorFetch && options.handle) {
		if (!options.password) {
			throw new Error(
				"--handle needs a password: set SPACE_CONFORMANCE_PASSWORD in the environment (or use --oauth)",
			);
		}
		operatorToken = await createSession(
			doFetch,
			origin,
			options.handle,
			options.password,
		);
	}

	const capabilities: Capability[] = [];
	if (operatorToken || options.operatorFetch) {
		capabilities.push("operator");
		// A full PDS exposes the blob endpoints and getDelegationToken; only a
		// standalone space host lacks them.
		if (!options.standaloneHost) {
			capabilities.push("pds-blobs", "pds-delegation");
		}
	}
	if (options.identities) capabilities.push("identities");

	const context: Omit<CheckContext, "state" | "log"> = {
		target: {
			origin,
			did,
			implementation: options.implementation,
		},
		fetch: doFetch,
		...(options.operatorFetch
			? { operator: { oauth: true, fetch: options.operatorFetch } }
			: operatorToken
				? {
						operator: {
							oauth: false,
							async authorize(init) {
								init.headers.set("Authorization", `Bearer ${operatorToken}`);
							},
						},
					}
				: {}),
		...(options.identities
			? { identities: new KeypairIdentityProvider() }
			: {}),
	};

	const catalog = filterCatalog(fullCatalog, {
		tiers: options.tiers,
		capabilities,
		destructive: options.destructive,
		slow: options.slow,
	});

	return runChecks({
		catalog,
		context,
		suiteVersion: options.suiteVersion,
		alphaBuild: ALPHA_BUILD,
	});
}

/**
 * Sign in at the target and return the session's access token. This is the
 * portable way to get operator auth: every standard PDS implements
 * `com.atproto.server.createSession`, where a static bearer like Cirrus's
 * AUTH_TOKEN is deployment-specific.
 */
async function createSession(
	doFetch: typeof fetch,
	origin: string,
	identifier: string,
	password: string,
): Promise<string> {
	const res = await doFetch(`${origin}/xrpc/com.atproto.server.createSession`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
	const body = (await res.json().catch(() => ({}))) as {
		accessJwt?: string;
		error?: string;
		message?: string;
	};
	if (!res.ok || !body.accessJwt) {
		throw new Error(
			`createSession failed for ${identifier} at ${origin}: ${res.status} ${body.error ?? ""} ${body.message ?? ""}`.trim(),
		);
	}
	return body.accessJwt;
}

async function resolveDid(
	doFetch: typeof fetch,
	origin: string,
): Promise<string> {
	const res = await doFetch(`${origin}/.well-known/did.json`);
	if (!res.ok) {
		throw new Error(
			`could not resolve target DID from ${origin}/.well-known/did.json (${res.status}); pass --did`,
		);
	}
	const doc = (await res.json()) as { id?: string };
	if (!doc.id) throw new Error("did.json has no id; pass --did");
	return doc.id;
}
