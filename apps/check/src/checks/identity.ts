import { ComAtprotoIdentityResolveHandle } from "@atcute/atproto";
import { getPdsEndpoint } from "@atcute/identity";
import { isDid, isHandle, type Did, type Handle } from "@atcute/lexicons/syntax";
import { didDocResolver, handleResolver } from "../lib/resolvers";
import { publicClient, validateLexicon } from "../lib/xrpc";
import type { Check, CheckOutcome } from "../types";

let pdsResolveHandleBody: ComAtprotoIdentityResolveHandle.$output | undefined;

const parseInput: Check = {
	id: "identity.parse-input",
	category: "identity",
	label: "Recognize input",
	run: async (ctx): Promise<CheckOutcome> => {
		const raw = ctx.target.trim().replace(/^@/, "");
		if (!raw) {
			return { status: "fail", message: "Empty input" };
		}
		// http(s):// prefix → "PDS URL" mode: skip identity resolution and run
		// PDS-only checks (server.*, sync.listRepos, OAuth discovery, etc.).
		// Checks requiring ctx.did will skip cleanly.
		if (/^https?:\/\//i.test(raw)) {
			try {
				const url = new URL(raw);
				const origin = url.origin;
				return {
					status: "pass",
					message: `PDS-URL mode: testing ${origin} directly — identity/repo/sync checks that need a user DID will skip`,
					context: { pds: origin },
				};
			} catch {
				return {
					status: "fail",
					message: `Not a parseable URL: ${raw}`,
					evidence: { actual: raw },
				};
			}
		}
		if (isDid(raw)) {
			return {
				status: "pass",
				message: `${raw} is a DID`,
				context: { did: raw },
			};
		}
		if (isHandle(raw)) {
			return {
				status: "pass",
				message: `${raw} is a handle`,
				context: { handle: raw },
			};
		}
		return {
			status: "fail",
			message: `Not a recognizable handle or DID. Looks like a hostname? Prefix with https:// to test it as a PDS URL (limited check surface — most checks require a user context).`,
			evidence: { actual: raw },
		};
	},
};

const resolveHandle: Check = {
	id: "identity.resolve-handle",
	category: "identity",
	label: "Resolve handle to DID",
	run: async (ctx): Promise<CheckOutcome> => {
		if (ctx.did) {
			return { status: "skip", message: "Input was already a DID" };
		}
		if (!ctx.handle) {
			return { status: "skip", message: "No handle to resolve" };
		}
		try {
			const did = await handleResolver.resolve(ctx.handle as Handle);
			return {
				status: "pass",
				message: did,
				context: { did },
			};
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			// If the input is a multi-level hostname that doesn't resolve as a
			// handle, it's most likely a PDS host, not a user account. Probe
			// /xrpc/_health to confirm and, if so, auto-switch to PDS-URL mode
			// so the rest of the run is useful.
			const looksLikeHostname = /\./.test(ctx.handle) && !ctx.handle.endsWith(".");
			if (looksLikeHostname) {
				const probeUrl = `https://${ctx.handle}/xrpc/_health`;
				try {
					const res = await fetch(probeUrl, {
						method: "GET",
						headers: { accept: "application/json" },
						signal: AbortSignal.timeout(3000),
					});
					if (res.ok) {
						// It's a PDS — switch into PDS-URL mode automatically.
						return {
							status: "warn",
							message: `not a user handle, but ${ctx.handle} responds to /xrpc/_health — auto-switching to PDS-URL mode. Identity/repo/sync checks needing a user DID will skip.`,
							evidence: {
								expected: "DNS TXT _atproto.<handle> or /.well-known/atproto-did to return a DID",
								actual: `handle resolution failed; ${probeUrl} returned ${res.status}`,
								error: errMsg,
							},
							context: { pds: `https://${ctx.handle}`, handle: undefined },
						};
					}
				} catch {
					// probe failed — fall through to the regular fail path with helpful message
				}
			}
			const hint = looksLikeHostname
				? ` (looks like a hostname — if this is a PDS rather than a user account, re-run with https://${ctx.handle})`
				: "";
			return {
				status: "fail",
				message: `${errMsg}${hint}`,
				evidence: { error: errMsg },
			};
		}
	},
};

const fetchDidDocument: Check = {
	id: "identity.fetch-did-document",
	category: "identity",
	label: "Fetch DID document",
	requires: ["did"],
	run: async (ctx): Promise<CheckOutcome> => {
		const did = ctx.did as Did<"plc" | "web">;
		try {
			const doc = await didDocResolver.resolve(did);
			return {
				status: "pass",
				message: `${doc.service?.length ?? 0} service entries`,
				evidence: { response: { body: doc } },
				context: { didDoc: doc },
			};
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
			};
		}
	},
};

const extractPdsEndpoint: Check = {
	id: "identity.extract-pds",
	category: "identity",
	label: "Extract PDS endpoint",
	requires: ["did"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (!ctx.didDoc) {
			return { status: "skip", message: "DID document unavailable" };
		}
		const pds = getPdsEndpoint(ctx.didDoc);
		if (!pds) {
			return {
				status: "fail",
				message: "No #atproto_pds service entry in DID document",
				evidence: { actual: ctx.didDoc.service },
			};
		}
		return {
			status: "pass",
			message: pds,
			context: { pds },
		};
	},
};

const pdsResolveHandle: Check = {
	id: "identity.pds-resolve-handle",
	category: "identity",
	label: "PDS resolves handle to DID",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		pdsResolveHandleBody = undefined;
		if (!ctx.handle) {
			return { status: "skip", message: "no handle in context" };
		}
		const client = publicClient(ctx.pds!);
		const res = await client.get("com.atproto.identity.resolveHandle", {
			params: { handle: ctx.handle as Handle },
		});
		if (!res.ok) {
			return {
				status: "fail",
				message: `${res.data.error}: ${res.data.message ?? ""}`.trim(),
				evidence: { response: { status: res.status, body: res.data } },
			};
		}
		pdsResolveHandleBody = res.data;
		if (ctx.did && res.data.did !== ctx.did) {
			return {
				status: "fail",
				message: `PDS returned ${res.data.did}, expected ${ctx.did}`,
				evidence: { expected: ctx.did, actual: res.data.did },
			};
		}
		return {
			status: "pass",
			message: res.data.did,
			evidence: { response: { body: res.data } },
		};
	},
};

const pdsResolveHandleValidates: Check = {
	id: "identity.pds-resolve-handle.validates",
	category: "identity",
	label: "PDS resolveHandle response matches lexicon",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!pdsResolveHandleBody) {
			return { status: "skip", message: "no response to validate" };
		}
		return validateLexicon(
			ComAtprotoIdentityResolveHandle.mainSchema.output.schema,
			pdsResolveHandleBody,
		);
	},
};

export const identityChecks: Check[] = [
	parseInput,
	resolveHandle,
	fetchDidDocument,
	extractPdsEndpoint,
	pdsResolveHandle,
	pdsResolveHandleValidates,
];
