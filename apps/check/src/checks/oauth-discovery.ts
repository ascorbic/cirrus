import type { Check, CheckOutcome } from "../types";

interface ProtectedResourceMetadata {
	resource?: string;
	authorization_servers?: string[];
	[k: string]: unknown;
}

interface JwksDocument {
	keys?: Array<Record<string, unknown>>;
	[k: string]: unknown;
}

let protectedResource: ProtectedResourceMetadata | undefined;
let authServerUrl: string | undefined;
let authServerMetadata: Record<string, unknown> | undefined;
let jwksUri: string | undefined;
let jwksDocument: JwksDocument | undefined;

function reset(): void {
	protectedResource = undefined;
	authServerUrl = undefined;
	authServerMetadata = undefined;
	jwksUri = undefined;
	jwksDocument = undefined;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchJson(
	url: string,
): Promise<
	| { ok: true; status: number; body: unknown }
	| { ok: false; status?: number; error: string; body?: unknown }
> {
	let response: Response;
	try {
		response = await fetch(url, { headers: { accept: "application/json" } });
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	let body: unknown;
	let text: string | undefined;
	try {
		text = await response.text();
		body = text.length === 0 ? undefined : JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			status: response.status,
			error: `JSON parse failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			body: text,
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			error: `HTTP ${response.status}`,
			body,
		};
	}
	return { ok: true, status: response.status, body };
}

const protectedResourceResponds: Check = {
	id: "oauth.protected-resource-responds",
	category: "oauth",
	label: ".well-known/oauth-protected-resource responds",
	description:
		"RFC 9728 OAuth Protected Resource Metadata document must be served at /.well-known/oauth-protected-resource.",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		reset();
		if (!ctx.pds) {
			return { status: "skip", message: "No PDS endpoint" };
		}
		const url = `${trimTrailingSlash(ctx.pds)}/.well-known/oauth-protected-resource`;
		const result = await fetchJson(url);
		if (!result.ok) {
			return {
				status: "fail",
				message: result.error,
				evidence: {
					request: { method: "GET", url },
					response: { status: result.status, body: result.body },
					error: result.error,
				},
			};
		}
		if (!result.body || typeof result.body !== "object") {
			return {
				status: "fail",
				message: "Response body is not a JSON object",
				evidence: {
					request: { method: "GET", url },
					response: { status: result.status, body: result.body },
				},
			};
		}
		protectedResource = result.body as ProtectedResourceMetadata;
		return {
			status: "pass",
			message: `HTTP ${result.status}`,
			evidence: {
				request: { method: "GET", url },
				response: { status: result.status, body: result.body },
			},
		};
	},
};

const protectedResourceValidates: Check = {
	id: "oauth.protected-resource-validates",
	category: "oauth",
	label: ".well-known/oauth-protected-resource validates",
	description:
		"Protected resource metadata must declare a resource matching the PDS and at least one authorization_servers entry.",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		if (!protectedResource) {
			return {
				status: "skip",
				message: "Protected resource metadata unavailable",
			};
		}
		const issues: string[] = [];
		const expectedResource = ctx.pds
			? trimTrailingSlash(ctx.pds)
			: undefined;
		const resource = protectedResource.resource;
		if (typeof resource !== "string" || resource.length === 0) {
			issues.push("missing field: resource");
		} else if (
			expectedResource &&
			trimTrailingSlash(resource) !== expectedResource
		) {
			issues.push(
				`resource: expected ${expectedResource}, got ${resource}`,
			);
		}
		const servers = protectedResource.authorization_servers;
		if (!Array.isArray(servers) || servers.length === 0) {
			issues.push(
				"missing or empty field: authorization_servers (must be non-empty array)",
			);
		} else if (!servers.every((s) => typeof s === "string" && s.length > 0)) {
			issues.push("authorization_servers must contain non-empty strings");
		} else {
			authServerUrl = trimTrailingSlash(servers[0]!);
		}
		if (issues.length > 0) {
			return {
				status: "fail",
				message: issues[0]!,
				evidence: {
					actual: protectedResource,
					error: issues.join("\n"),
				},
			};
		}
		return {
			status: "pass",
			message: `resource=${resource}, authorization_servers[${servers!.length}]`,
			evidence: { actual: protectedResource },
		};
	},
};

const authServerResponds: Check = {
	id: "oauth.auth-server-responds",
	category: "oauth",
	label: ".well-known/oauth-authorization-server responds",
	description:
		"RFC 8414 OAuth Authorization Server Metadata document must be served by the authorization server.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!authServerUrl) {
			return {
				status: "skip",
				message: "no authorization_server discovered",
			};
		}
		const url = `${authServerUrl}/.well-known/oauth-authorization-server`;
		const result = await fetchJson(url);
		if (!result.ok) {
			return {
				status: "fail",
				message: result.error,
				evidence: {
					request: { method: "GET", url },
					response: { status: result.status, body: result.body },
					error: result.error,
				},
			};
		}
		if (!result.body || typeof result.body !== "object") {
			return {
				status: "fail",
				message: "Response body is not a JSON object",
				evidence: {
					request: { method: "GET", url },
					response: { status: result.status, body: result.body },
				},
			};
		}
		authServerMetadata = result.body as Record<string, unknown>;
		return {
			status: "pass",
			message: `HTTP ${result.status}`,
			evidence: {
				request: { method: "GET", url },
				response: { status: result.status, body: result.body },
			},
		};
	},
};

const REQUIRED_RFC8414_FIELDS = [
	"issuer",
	"authorization_endpoint",
	"token_endpoint",
	"response_types_supported",
] as const;

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((v) => typeof v === "string")
		? (value as string[])
		: undefined;
}

const authServerValidates: Check = {
	id: "oauth.auth-server-validates",
	category: "oauth",
	label: ".well-known/oauth-authorization-server validates",
	description:
		"Metadata must satisfy RFC 8414 required fields and the AT Protocol OAuth profile (DPoP ES256, PAR, S256, atproto scope, client_id_metadata_document_supported).",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!authServerMetadata) {
			return {
				status: "skip",
				message: "Authorization server metadata unavailable",
			};
		}
		const md = authServerMetadata;
		const failures: string[] = [];

		for (const field of REQUIRED_RFC8414_FIELDS) {
			if (md[field] === undefined || md[field] === null) {
				failures.push(`missing field: ${field}`);
			}
		}
		if (
			md.response_types_supported !== undefined &&
			!asStringArray(md.response_types_supported)
		) {
			failures.push("response_types_supported must be an array of strings");
		}

		const dpopAlgs = asStringArray(md.dpop_signing_alg_values_supported);
		if (!dpopAlgs) {
			failures.push(
				"missing field: dpop_signing_alg_values_supported (must include ES256)",
			);
		} else if (!dpopAlgs.includes("ES256")) {
			failures.push(
				`dpop_signing_alg_values_supported: must include ES256, got [${dpopAlgs.join(", ")}]`,
			);
		}

		if (typeof md.pushed_authorization_request_endpoint !== "string") {
			failures.push("missing field: pushed_authorization_request_endpoint");
		}

		if (md.require_pushed_authorization_requests !== true) {
			failures.push(
				`require_pushed_authorization_requests: expected true, got ${JSON.stringify(
					md.require_pushed_authorization_requests,
				)}`,
			);
		}

		const codeChallenge = asStringArray(md.code_challenge_methods_supported);
		if (!codeChallenge) {
			failures.push(
				"missing field: code_challenge_methods_supported (must include S256)",
			);
		} else if (!codeChallenge.includes("S256")) {
			failures.push(
				`code_challenge_methods_supported: must include S256, got [${codeChallenge.join(", ")}]`,
			);
		}

		const scopes = asStringArray(md.scopes_supported);
		if (!scopes) {
			failures.push("missing field: scopes_supported (must include atproto)");
		} else if (!scopes.includes("atproto")) {
			failures.push(
				`scopes_supported: must include atproto, got [${scopes.join(", ")}]`,
			);
		}

		if (md.client_id_metadata_document_supported !== true) {
			failures.push(
				`client_id_metadata_document_supported: expected true, got ${JSON.stringify(
					md.client_id_metadata_document_supported,
				)}`,
			);
		}

		if (typeof md.jwks_uri === "string" && md.jwks_uri.length > 0) {
			jwksUri = md.jwks_uri;
		}

		const warnings: string[] = [];
		if (md.grant_types_supported === undefined) {
			warnings.push(
				"recommended field missing: grant_types_supported (should include authorization_code and refresh_token)",
			);
		} else {
			const grants = asStringArray(md.grant_types_supported);
			if (grants) {
				if (!grants.includes("authorization_code")) {
					warnings.push(
						"grant_types_supported: should include authorization_code",
					);
				}
				if (!grants.includes("refresh_token")) {
					warnings.push(
						"grant_types_supported: should include refresh_token",
					);
				}
			}
		}
		if (md.token_endpoint_auth_methods_supported === undefined) {
			warnings.push(
				"recommended field missing: token_endpoint_auth_methods_supported",
			);
		}
		if (md.jwks_uri === undefined) {
			warnings.push("recommended field missing: jwks_uri");
		}

		if (failures.length > 0) {
			return {
				status: "fail",
				message: failures[0]!,
				evidence: {
					actual: md,
					error: [...failures, ...warnings].join("\n"),
				},
			};
		}
		if (warnings.length > 0) {
			return {
				status: "warn",
				message: warnings[0]!,
				evidence: {
					actual: md,
					error: warnings.join("\n"),
				},
			};
		}
		return {
			status: "pass",
			message: "RFC 8414 + AT Protocol OAuth profile satisfied",
			evidence: { actual: md },
		};
	},
};

const jwksResponds: Check = {
	id: "oauth.jwks-responds",
	category: "oauth",
	label: "JWKS endpoint responds",
	description:
		"The authorization server's jwks_uri must return a JSON Web Key Set.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!jwksUri) {
			return { status: "skip", message: "no jwks_uri" };
		}
		const result = await fetchJson(jwksUri);
		if (!result.ok) {
			return {
				status: "fail",
				message: result.error,
				evidence: {
					request: { method: "GET", url: jwksUri },
					response: { status: result.status, body: result.body },
					error: result.error,
				},
			};
		}
		if (!result.body || typeof result.body !== "object") {
			return {
				status: "fail",
				message: "Response body is not a JSON object",
				evidence: {
					request: { method: "GET", url: jwksUri },
					response: { status: result.status, body: result.body },
				},
			};
		}
		jwksDocument = result.body as JwksDocument;
		return {
			status: "pass",
			message: `HTTP ${result.status}`,
			evidence: {
				request: { method: "GET", url: jwksUri },
				response: { status: result.status, body: result.body },
			},
		};
	},
};

const jwksValidates: Check = {
	id: "oauth.jwks-validates",
	category: "oauth",
	label: "JWKS document validates",
	description:
		"JWKS must be a JSON object with a `keys` array per RFC 7517. Each key, if present, must carry kty/kid (alg is recommended). An empty keys array is technically valid — the AS may not need to publish any signing keys (DPoP uses client-side keys, not AS keys).",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!jwksDocument) {
			return { status: "skip", message: "JWKS document unavailable" };
		}
		const hardFailures: string[] = [];
		const warnings: string[] = [];
		const keys = jwksDocument.keys;
		if (!Array.isArray(keys)) {
			return {
				status: "fail",
				message: "missing field: keys (must be an array)",
				evidence: {
					actual: jwksDocument,
					error: "missing field: keys",
				},
			};
		}
		if (keys.length === 0) {
			warnings.push(
				"keys array is empty (valid per RFC 7517, but AS publishes no verifiable signing keys)",
			);
		}
		keys.forEach((key, i) => {
			if (!key || typeof key !== "object") {
				hardFailures.push(`keys[${i}]: not a JSON object`);
				return;
			}
			// kty is required per RFC 7517 §4.1
			if (typeof key.kty !== "string" || (key.kty as string).length === 0) {
				hardFailures.push(`keys[${i}]: missing field kty (required by RFC 7517 §4.1)`);
			}
			// kid is recommended for key rotation; warn if absent
			if (typeof key.kid !== "string" || (key.kid as string).length === 0) {
				warnings.push(`keys[${i}]: missing kid (recommended for key rotation)`);
			}
			// alg is recommended for clarity; warn if absent
			if (typeof key.alg !== "string" || (key.alg as string).length === 0) {
				warnings.push(`keys[${i}]: missing alg (recommended)`);
			}
		});
		if (hardFailures.length > 0) {
			return {
				status: "fail",
				message: hardFailures[0]!,
				evidence: {
					actual: jwksDocument,
					error: [...hardFailures, ...warnings].join("\n"),
				},
			};
		}
		if (warnings.length > 0) {
			return {
				status: "warn",
				message:
					warnings.length === 1
						? warnings[0]!
						: `${warnings.length} non-blocking issues`,
				evidence: {
					actual: jwksDocument,
					error: warnings.join("\n"),
				},
			};
		}
		return {
			status: "pass",
			message: `${keys.length} key${keys.length === 1 ? "" : "s"}`,
			evidence: { actual: jwksDocument },
		};
	},
};

const scopeAdvertises = (
	id: string,
	label: string,
	predicate: (scopes: readonly string[]) => CheckOutcome,
): Check => ({
	id,
	category: "oauth",
	label,
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!authServerMetadata) {
			return {
				status: "skip",
				message: "auth server metadata unavailable",
			};
		}
		const raw = authServerMetadata.scopes_supported;
		if (!Array.isArray(raw)) {
			return {
				status: "fail",
				message: "scopes_supported missing or not an array",
				evidence: { actual: raw },
			};
		}
		const scopes = raw.filter((s): s is string => typeof s === "string");
		return predicate(scopes);
	},
});

const scopeAdvertisesAtproto = scopeAdvertises(
	"oauth-discovery.scope-atproto",
	"Auth server advertises atproto scope",
	(scopes) =>
		scopes.includes("atproto")
			? {
					status: "pass",
					message: "atproto scope advertised (required)",
				}
			: {
					status: "fail",
					message: "scopes_supported is missing atproto (required by spec)",
					evidence: { actual: scopes },
				},
);

const scopeAdvertisesTransitionGeneric = scopeAdvertises(
	"oauth-discovery.scope-transition-generic",
	"Auth server advertises transition:generic",
	(scopes) =>
		scopes.includes("transition:generic")
			? {
					status: "pass",
					message: "transition:generic advertised (legacy bundle)",
				}
			: {
					status: "warn",
					message:
						"transition:generic missing — most clients still rely on this bundle",
					evidence: { actual: scopes },
				},
);

const scopeAdvertisesResourceBuckets = scopeAdvertises(
	"oauth-discovery.scope-resource-buckets",
	"Auth server advertises granular resource scopes",
	(scopes) => {
		// Per atproto.com/specs/permission, granular scopes are bare resource-
		// type tokens (repo, rpc, blob, account, identity) in scopes_supported.
		// Clients construct fully-qualified scopes by appending parameters at
		// request time (e.g. `repo:my.collection?action=create`).
		const RESOURCES = ["repo", "rpc", "blob", "identity", "account"] as const;
		const present = RESOURCES.filter((r) => scopes.includes(r));
		if (present.length === 0) {
			return {
				status: "warn",
				message:
					"no granular resource scopes (repo, rpc, blob, identity, account) advertised — AS supports only legacy transition:* bundles",
				evidence: {
					expected:
						"scopes_supported to include resource-type tokens: repo, rpc, blob, account, identity",
					actual: scopes,
				},
			};
		}
		const missing = RESOURCES.filter((r) => !scopes.includes(r));
		if (missing.length > 0) {
			return {
				status: "warn",
				message: `partial: advertises ${present.join(", ")}; missing ${missing.join(", ")}`,
				evidence: { actual: { present, missing } },
			};
		}
		return {
			status: "pass",
			message: `all five granular resources advertised: ${present.join(", ")}`,
			evidence: { actual: present },
		};
	},
);

const scopeAdvertisesPermissionSets = scopeAdvertises(
	"oauth-discovery.scope-permission-sets",
	"Auth server advertises permission set support",
	(scopes) => {
		// The AS advertises `include` as a resource type to signal it supports
		// permission sets; specific include:<nsid> scopes are dynamically
		// resolved at PAR time via lexicon resolution, not enumerated here.
		if (!scopes.includes("include")) {
			return {
				status: "warn",
				message:
					"`include` not in scopes_supported — AS does not advertise permission set resolution",
				evidence: {
					expected: "`include` token in scopes_supported",
					actual: scopes,
				},
			};
		}
		return {
			status: "pass",
			message: "`include` advertised — AS resolves permission sets dynamically via lexicon resolution",
			evidence: { actual: ["include"] },
		};
	},
);

export const oauthDiscoveryChecks: Check[] = [
	protectedResourceResponds,
	protectedResourceValidates,
	authServerResponds,
	authServerValidates,
	scopeAdvertisesAtproto,
	scopeAdvertisesTransitionGeneric,
	scopeAdvertisesResourceBuckets,
	scopeAdvertisesPermissionSets,
	jwksResponds,
	jwksValidates,
];
