import { Client } from "@atcute/client";
import type { ActorIdentifier, Did, Handle } from "@atcute/lexicons/syntax";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import * as oauth from "oauth4webapi";
import { createStore, produce } from "solid-js/store";
import { actorResolver } from "./resolvers";

export type StepStatus =
	| "pending"
	| "running"
	| "pass"
	| "fail"
	| "warn"
	| "skip";

export interface FlowStep {
	id: string;
	label: string;
	status: StepStatus;
	message?: string;
	evidence?: unknown;
	startedAt?: number;
	endedAt?: number;
}

export interface FlowState {
	phase:
		| "idle"
		| "pre-redirect"
		| "ready-to-redirect"
		| "redirecting"
		| "post-callback"
		| "done";
	target: string;
	handle?: string;
	did?: string;
	pds?: string;
	authServerUrl?: string;
	authServer?: oauth.AuthorizationServer;
	protectedResource?: Record<string, unknown>;
	codeVerifier?: string;
	codeChallenge?: string;
	stateNonce?: string;
	requestUri?: string;
	authUrl?: string;
	accessToken?: string;
	refreshToken?: string;
	tokenType?: string;
	steps: FlowStep[];
	startedAt: number;
	endedAt?: number;
}

const STATE_KEY = "pdscheck.oauth-flow.state";
const DPOP_KEY = "pdscheck.oauth-flow.dpop-keypair";

interface PersistedState {
	target: string;
	handle?: string;
	did?: string;
	pds?: string;
	authServerUrl?: string;
	codeVerifier: string;
	stateNonce: string;
	expectedIss: string;
	scope: string;
}

// Scope is chosen at runtime based on the auth server's advertised scopes:
// prefer the granular Phase 2 form when supported, fall back to the legacy
// bundle otherwise. PDSes like bsky that don't advertise `repo:*` will reject
// the granular scope at PAR ("invalid_scope: not declared in client metadata"),
// so we don't even attempt it on those servers.
const LEGACY_SCOPE = "atproto transition:generic";
const GRANULAR_SCOPE =
	"atproto repo:earth.cirrus.check.testrecord include:site.standard.authFull";
const OUT_OF_SCOPE_COLLECTION = "earth.cirrus.check.othertestrecord";
const CALLBACK_PATH = "/oauth/flow-callback";

// Mutable so the select-scope step can set it for the rest of the pre-redirect
// flow, and post-callback can restore it from persisted state. Single in-flight
// flow at a time so this is safe.
let activeScope: string = LEGACY_SCOPE;

function clientId(): string {
	const isLoopback =
		location.hostname === "localhost" || location.hostname === "127.0.0.1";
	const redirectUri = `${location.origin}${CALLBACK_PATH}`;
	if (isLoopback) {
		const params = new URLSearchParams({
			redirect_uri: redirectUri,
			scope: activeScope,
		});
		return `http://localhost?${params.toString()}`;
	}
	return `${location.origin}/client-metadata.json`;
}

// Whether the granted scope authorizes a createRecord to a given collection.
// atproto granular scopes for repo come in two forms:
//   `repo:<collection>[?action=...]`     — single-collection token
//   `repo?collection=<X>&collection=<Y>` — multi-collection token (produced by
//                                          permission-set expansion)
// Default actions cover create+update+delete. `repo:*` grants any collection.
// `transition:generic` is the legacy catch-all.
function scopeGrantsWriteTo(grantedScope: string, collection: string): boolean {
	const parts = grantedScope.split(/\s+/).filter(Boolean);
	return parts.some((s) => {
		if (s === "transition:generic") return true;
		// Multi-collection form: repo?collection=X&collection=Y[&action=...]
		if (s.startsWith("repo?")) {
			const params = new URLSearchParams(s.slice("repo?".length));
			const collections = params.getAll("collection");
			const matchesCollection = collections.some(
				(c) => c === "*" || c === collection,
			);
			if (!matchesCollection) return false;
			const actions = params.getAll("action");
			if (actions.length === 0) return true;
			return actions.includes("create") || actions.includes("*");
		}
		// Single-collection form: repo:<collection>[?action=...]
		const match = s.match(/^repo:([^?]+)(?:\?(.*))?$/);
		if (!match) return false;
		const scopeCollection = decodeURIComponent(match[1]!);
		if (scopeCollection !== "*" && scopeCollection !== collection) return false;
		const actions = new URLSearchParams(match[2] ?? "").getAll("action");
		if (actions.length === 0) return true;
		return actions.includes("create") || actions.includes("*");
	});
}

function redirectUri(): string {
	return `${location.origin}${CALLBACK_PATH}`;
}

// RFC 9449 §8: a DPoP-aware authorization server may require requests to carry
// a `nonce` claim in the proof, signaling this by returning use_dpop_nonce on
// the first attempt and a DPoP-Nonce response header. oauth4webapi's DPoP
// handle captures the nonce automatically from any response that carries one,
// so we just need to retry the call once after a use_dpop_nonce error.
async function withNonceRetry<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (oauth.isDPoPNonceError(error)) {
			return await call();
		}
		throw error;
	}
}

// protectedResourceRequest may THROW a WWWAuthenticateChallengeError when the
// response has an OAuth error in WWW-Authenticate (RFC 6750/9449). The
// Response is still on the error (body unused), so we unwrap to a Response and
// then check for use_dpop_nonce — if so, the DPoP handle has captured the
// nonce, retry once. Otherwise return the Response so the caller can inspect
// it normally (status/headers/body) and surface the challenge in evidence.
/**
 * Reads an OAuth-style error response: prefer the JSON body's `error` /
 * `error_description`, fall back to the WWW-Authenticate header, then to the
 * HTTP status. Returns a concise message and the parsed body for evidence.
 */
async function readOAuthError(
	res: Response,
): Promise<{ message: string; body: unknown; wwwAuthenticate: string | null }> {
	const wwwAuthenticate = res.headers.get("www-authenticate");
	let body: unknown;
	try {
		body = await res.clone().json();
	} catch {
		body = await res.text().catch(() => "");
	}
	const errBody = body as
		| {
				error?: string;
				message?: string;
				error_description?: string;
		  }
		| undefined;
	const errCode = errBody?.error;
	const errDesc = errBody?.message ?? errBody?.error_description;
	let message: string;
	if (errCode) {
		message = errDesc ? `${errCode}: ${errDesc}` : errCode;
	} else if (wwwAuthenticate) {
		message = `HTTP ${res.status} — ${wwwAuthenticate}`;
	} else {
		message = `HTTP ${res.status}`;
	}
	return { message, body, wwwAuthenticate };
}

async function protectedFetchWithNonceRetry(
	...args: Parameters<typeof oauth.protectedResourceRequest>
): Promise<Response> {
	const call = async (): Promise<Response> => {
		try {
			return await oauth.protectedResourceRequest(...args);
		} catch (err) {
			if (err instanceof oauth.WWWAuthenticateChallengeError) {
				return err.response;
			}
			throw err;
		}
	};

	let res = await call();
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		const challenge = (
			res.headers.get("www-authenticate") ?? ""
		).toLowerCase();
		let isNonceChallenge = challenge.includes("use_dpop_nonce");
		if (!isNonceChallenge) {
			try {
				const peeked = (await res.clone().json()) as { error?: string };
				if (peeked?.error === "use_dpop_nonce") isNonceChallenge = true;
			} catch {
				// non-JSON body — keep isNonceChallenge as-is
			}
		}
		if (isNonceChallenge) res = await call();
	}
	return res;
}

export function isFlowCallback(): boolean {
	return location.pathname === CALLBACK_PATH;
}

async function persistState(state: PersistedState) {
	sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function loadPersistedState(): PersistedState | null {
	try {
		const raw = sessionStorage.getItem(STATE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as PersistedState;
	} catch {
		return null;
	}
}

function clearPersistedState() {
	sessionStorage.removeItem(STATE_KEY);
}

async function persistDpopKey(keyPair: CryptoKeyPair) {
	await idbSet(DPOP_KEY, keyPair);
}

async function loadDpopKey(): Promise<CryptoKeyPair | null> {
	try {
		const kp = (await idbGet(DPOP_KEY)) as CryptoKeyPair | undefined;
		return kp ?? null;
	} catch {
		return null;
	}
}

async function clearDpopKey() {
	try {
		await idbDel(DPOP_KEY);
	} catch {
		// best-effort
	}
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url.replace(/\/+$/, "");
	}
}

async function generateDpopKeyPair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	)) as CryptoKeyPair;
}

const PRE_REDIRECT_STEPS = [
	"flow.resolve-target",
	"flow.discover-protected-resource",
	"flow.discover-auth-server",
	"flow.validate-auth-server-metadata",
	"flow.atproto-conformance",
	"flow.select-scope",
	"flow.generate-pkce",
	"flow.generate-dpop-key",
	"flow.send-par",
	"flow.par-response-shape",
	"flow.par-rejects-unregistered-redirect-uri",
	"flow.par-rejects-invalid-include",
	"flow.par-accepts-advertised-include",
	"flow.par-accepts-known-permission-set",
	"flow.build-authorization-url",
] as const;

const POST_CALLBACK_STEPS = [
	"flow.callback-params-present",
	"flow.iss-matches",
	"flow.state-matches",
	"flow.exchange-code",
	"flow.token-response-shape",
	"flow.scope-echoed",
	"flow.use-access-token",
	"flow.session-did-matches",
	"flow.boundary-write-in-scope",
	"flow.boundary-write-out-of-scope",
	"flow.boundary-cleanup",
	"flow.refresh-token",
	"flow.use-refreshed-token",
	"flow.revoke-token",
	"flow.revoked-token-rejected",
] as const;

function initialStepsFor(ids: readonly string[]): FlowStep[] {
	const labels: Record<string, string> = {
		"flow.resolve-target": "Resolve handle to DID and PDS",
		"flow.discover-protected-resource":
			"Discover .well-known/oauth-protected-resource",
		"flow.discover-auth-server":
			"Discover .well-known/oauth-authorization-server",
		"flow.validate-auth-server-metadata":
			"Auth server metadata validates (oauth4webapi)",
		"flow.atproto-conformance": "AT Proto OAuth conformance",
		"flow.select-scope":
			"Select scope (granular when AS advertises, legacy otherwise)",
		"flow.generate-pkce": "Generate PKCE code verifier and challenge",
		"flow.generate-dpop-key": "Generate DPoP ES256 keypair",
		"flow.send-par": "Send pushed authorization request",
		"flow.par-response-shape": "PAR response contains request_uri + expires_in",
		"flow.par-rejects-unregistered-redirect-uri":
			"PAR rejects unregistered redirect_uri (RFC 6749 §3.1.2.4)",
		"flow.par-rejects-invalid-include":
			"PAR rejects a nonexistent permission set include:",
		"flow.par-accepts-advertised-include":
			"PAR accepts an include: scope advertised in scopes_supported",
		"flow.par-accepts-known-permission-set":
			"PAR accepts include:site.standard.authFull (a published, lexicon-resolved permission set)",
		"flow.build-authorization-url": "Build authorization URL",
		"flow.callback-params-present": "Callback has code, state, iss",
		"flow.iss-matches": "iss parameter matches auth server (RFC 9207)",
		"flow.state-matches": "state matches the nonce we sent",
		"flow.exchange-code": "Exchange code for tokens",
		"flow.token-response-shape":
			"Token response has access_token, refresh_token, token_type=DPoP",
		"flow.scope-echoed": "Granted scope echoes the requested scope",
		"flow.use-access-token": "Call getSession with DPoP-bound access token",
		"flow.session-did-matches": "Session DID matches expected",
		"flow.boundary-write-in-scope":
			"In-scope createRecord (collection covered by scope) succeeds",
		"flow.boundary-write-out-of-scope":
			"Out-of-scope createRecord is rejected with insufficient_scope",
		"flow.boundary-cleanup": "Clean up any records left from boundary tests",
		"flow.refresh-token": "Refresh access token",
		"flow.use-refreshed-token": "Call getSession with refreshed token",
		"flow.revoke-token": "Revoke access token",
		"flow.revoked-token-rejected": "Revoked token is rejected",
	};
	return ids.map((id) => ({
		id,
		label: labels[id] ?? id,
		status: "pending" as StepStatus,
	}));
}

function createFlowState(target: string): FlowState {
	return {
		phase: "pre-redirect",
		target,
		steps: initialStepsFor([...PRE_REDIRECT_STEPS, ...POST_CALLBACK_STEPS]),
		startedAt: Date.now(),
	};
}

// Reactive flow run

export interface FlowRun {
	state: FlowState;
	cancel: () => void;
	redirect: () => void;
}

export function startPreRedirectFlow(target: string): FlowRun {
	const [state, setState] = createStore<FlowState>(createFlowState(target));
	let aborted = false;

	const idxOf = (id: string) => state.steps.findIndex((s) => s.id === id);
	const setStep = (id: string, patch: Partial<FlowStep>) => {
		const i = idxOf(id);
		if (i < 0) return;
		setState(
			"steps",
			i,
			produce((s) => Object.assign(s, patch)),
		);
	};

	const runStep = async <T>(
		id: string,
		fn: () => Promise<{
			status: Exclude<StepStatus, "pending" | "running">;
			message?: string;
			evidence?: unknown;
			patch?: Partial<FlowState>;
			result?: T;
		}>,
	): Promise<T | undefined> => {
		if (aborted) return undefined;
		setStep(id, { status: "running", startedAt: Date.now() });
		try {
			const out = await fn();
			if (out.patch)
				setState(produce((s) => Object.assign(s, out.patch)));
			setStep(id, {
				status: out.status,
				message: out.message,
				evidence: out.evidence,
				endedAt: Date.now(),
			});
			return out.result;
		} catch (error) {
			setStep(id, {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
				endedAt: Date.now(),
			});
			throw error;
		}
	};

	const haltAndSkipRest = () => {
		for (let i = 0; i < state.steps.length; i++) {
			if (state.steps[i]!.status === "pending") {
				setState(
					"steps",
					i,
					produce((s) => {
						s.status = "skip";
						s.message = "previous step failed";
					}),
				);
			}
		}
		setState("phase", "done");
		setState("endedAt", Date.now());
	};

	void (async () => {
		try {
			// 1. Resolve target
			const resolved = await runStep<{
				did: Did;
				handle: Handle;
				pds: string;
			}>("flow.resolve-target", async () => {
				const r = await actorResolver.resolve(target as ActorIdentifier);
				return {
					status: "pass",
					message: `${r.handle} → ${r.did} @ ${r.pds}`,
					evidence: r,
					patch: { handle: r.handle, did: r.did, pds: originOf(r.pds) },
					result: {
						did: r.did,
						handle: r.handle,
						pds: originOf(r.pds),
					},
				};
			});
			if (!resolved) {
				haltAndSkipRest();
				return;
			}

			// 2. Discover protected resource
			const protectedResource = await runStep<Record<string, unknown>>(
				"flow.discover-protected-resource",
				async () => {
					const url = `${resolved.pds}/.well-known/oauth-protected-resource`;
					const res = await fetch(url, {
						headers: { accept: "application/json" },
					});
					if (!res.ok)
						return {
							status: "fail",
							message: `HTTP ${res.status}`,
							evidence: { request: { method: "GET", url }, response: { status: res.status } },
						};
					const body = (await res.json()) as Record<string, unknown>;
					const servers = body.authorization_servers;
					if (!Array.isArray(servers) || servers.length === 0) {
						return {
							status: "fail",
							message: "authorization_servers is empty or missing",
							evidence: { actual: body },
						};
					}
					return {
						status: "pass",
						message: `auth server: ${servers[0] as string}`,
						evidence: { response: { status: res.status, body } },
						patch: {
							protectedResource: body,
							authServerUrl: servers[0] as string,
						},
						result: body,
					};
				},
			);
			if (!protectedResource) {
				haltAndSkipRest();
				return;
			}

			// 3. Discover auth server
			const authServer = await runStep<oauth.AuthorizationServer>(
				"flow.discover-auth-server",
				async () => {
					const issuerUrl = new URL(state.authServerUrl!);
					const res = await oauth.discoveryRequest(issuerUrl, {
						algorithm: "oauth2",
					});
					if (!res.ok)
						return {
							status: "fail",
							message: `HTTP ${res.status}`,
							evidence: { response: { status: res.status } },
						};
					const body = (await res.clone().json()) as Record<string, unknown>;
					return {
						status: "pass",
						message: `issuer: ${body.issuer as string}`,
						evidence: { response: { body } },
						patch: { authServer: body as oauth.AuthorizationServer },
						result: body as oauth.AuthorizationServer,
					};
				},
			);
			if (!authServer) {
				haltAndSkipRest();
				return;
			}

			// 4. Validate auth server metadata via oauth4webapi
			await runStep("flow.validate-auth-server-metadata", async () => {
				const issuerUrl = new URL(state.authServerUrl!);
				const res = await oauth.discoveryRequest(issuerUrl, {
					algorithm: "oauth2",
				});
				try {
					const validated = await oauth.processDiscoveryResponse(
						issuerUrl,
						res,
					);
					return {
						status: "pass",
						message: "oauth4webapi accepts the metadata",
						evidence: { response: { body: validated } },
						patch: { authServer: validated },
					};
				} catch (error) {
					return {
						status: "fail",
						message:
							error instanceof Error ? error.message : String(error),
						evidence: { error: String(error) },
					};
				}
			});

			// 5. AT Proto-specific conformance
			await runStep("flow.atproto-conformance", async () => {
				const issues: string[] = [];
				const as = state.authServer!;
				const get = (k: string) => (as as Record<string, unknown>)[k];

				if (get("require_pushed_authorization_requests") !== true)
					issues.push(
						"require_pushed_authorization_requests must be true",
					);
				if (!get("pushed_authorization_request_endpoint"))
					issues.push("pushed_authorization_request_endpoint missing");
				const dpopAlgs = get("dpop_signing_alg_values_supported");
				if (
					!Array.isArray(dpopAlgs) ||
					!(dpopAlgs as unknown[]).includes("ES256")
				)
					issues.push("dpop_signing_alg_values_supported missing ES256");
				const pkceMethods = get("code_challenge_methods_supported");
				if (
					!Array.isArray(pkceMethods) ||
					!(pkceMethods as unknown[]).includes("S256")
				)
					issues.push("code_challenge_methods_supported missing S256");
				const scopes = get("scopes_supported");
				if (
					!Array.isArray(scopes) ||
					!(scopes as unknown[]).includes("atproto")
				)
					issues.push("scopes_supported missing atproto");
				const authMethods = get(
					"token_endpoint_auth_methods_supported",
				);
				const authMethodArr = Array.isArray(authMethods)
					? (authMethods as unknown[])
					: [];
				if (!authMethodArr.includes("none"))
					issues.push(
						"token_endpoint_auth_methods_supported missing none (required for public clients)",
					);
				if (!authMethodArr.includes("private_key_jwt"))
					issues.push(
						"token_endpoint_auth_methods_supported missing private_key_jwt (atproto spec requires both)",
					);
				if (get("client_id_metadata_document_supported") !== true)
					issues.push(
						"client_id_metadata_document_supported must be true",
					);
				if (get("authorization_response_iss_parameter_supported") !== true)
					issues.push(
						"authorization_response_iss_parameter_supported must be true (RFC 9207)",
					);

				if (issues.length === 0) {
					return {
						status: "pass",
						message: "all atproto MUSTs satisfied",
					};
				}
				return {
					status: "fail",
					message:
						issues.length === 1
							? issues[0]!
							: `${issues.length} conformance issues — ${issues[0]}`,
					evidence: { error: issues.join("\n") },
				};
			});

			// 5b. Select scope based on what the AS advertises.
			await runStep("flow.select-scope", async () => {
				const supported = (
					(state.authServer as Record<string, unknown> | undefined)
						?.scopes_supported as string[] | undefined
				)?.filter((s) => typeof s === "string") ?? [];
				const hasGranular = supported.some(
					(s) =>
						s === "repo" ||
						s.startsWith("repo:") ||
						s.startsWith("repo "),
				);
				activeScope = hasGranular ? GRANULAR_SCOPE : LEGACY_SCOPE;
				if (hasGranular) {
					return {
						status: "pass",
						message: `granular scope: ${activeScope}`,
						evidence: {
							actual: {
								scopesSupported: supported,
								selected: activeScope,
							},
						},
					};
				}
				return {
					status: "warn",
					message: `AS doesn't advertise repo:* scopes — falling back to legacy ${LEGACY_SCOPE}; granular boundary tests will skip`,
					evidence: {
						expected:
							"scopes_supported to include at least one repo:* (Phase 2 granular) scope",
						actual: {
							scopesSupported: supported,
							selected: activeScope,
						},
						error:
							"PDS doesn't support Phase 2 granular scopes — the verifier can't differentiate scope enforcement using this AS.",
					},
				};
			});

			// 6. Generate PKCE
			const codeVerifier = oauth.generateRandomCodeVerifier();
			const codeChallenge =
				await oauth.calculatePKCECodeChallenge(codeVerifier);
			const stateNonce = oauth.generateRandomState();
			await runStep("flow.generate-pkce", async () => ({
				status: "pass",
				message: "verifier + S256 challenge generated",
				evidence: {
					response: {
						body: {
							verifierLength: codeVerifier.length,
							challenge: codeChallenge,
						},
					},
				},
				patch: { codeVerifier, codeChallenge, stateNonce },
			}));

			// 7. Generate DPoP keypair
			const dpopKeyPair = await generateDpopKeyPair();
			await persistDpopKey(dpopKeyPair);
			await runStep("flow.generate-dpop-key", async () => ({
				status: "pass",
				message: "ECDSA P-256 keypair, non-extractable",
				evidence: {
					response: {
						body: { algorithm: "ES256", curve: "P-256" },
					},
				},
			}));

			// 8. Send PAR (with DPoP-nonce retry built in — RFC 9449 §8 allows the
			// AS to require a nonce; the first request fails with use_dpop_nonce
			// and the captured nonce is used automatically on retry.)
			const parParams = {
				client_id: clientId(),
				redirect_uri: redirectUri(),
				response_type: "code",
				scope: activeScope,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				state: stateNonce,
				login_hint: resolved.handle,
			};
			const dpop = oauth.DPoP({ [oauth.clockSkew]: 0 }, dpopKeyPair);
			const sendPAR = () =>
				oauth.pushedAuthorizationRequest(
					state.authServer!,
					{ client_id: clientId() },
					oauth.None(),
					parParams,
					{ DPoP: dpop },
				);

			const parResponse = await runStep<Response>(
				"flow.send-par",
				async () => {
					try {
						const res = await sendPAR();
						return {
							status: "pass",
							message: `HTTP ${res.status}`,
							evidence: { response: { status: res.status } },
							result: res,
						};
					} catch (error) {
						return {
							status: "fail",
							message:
								error instanceof Error ? error.message : String(error),
							evidence: { error: String(error) },
						};
					}
				},
			);
			if (!parResponse) {
				haltAndSkipRest();
				return;
			}

			// 9. Validate PAR response.
			// If the AS responded with use_dpop_nonce, the DPoP handle captured the
			// nonce automatically — we just re-send PAR with the new proof and process.
			let nonceRetried = false;
			const requestUri = await runStep<string>(
				"flow.par-response-shape",
				async () => {
					const tryProcess = async (res: Response) =>
						await oauth.processPushedAuthorizationResponse(
							state.authServer!,
							{ client_id: clientId() },
							res,
						);
					try {
						let par: oauth.PushedAuthorizationResponse;
						try {
							par = await tryProcess(parResponse);
						} catch (error) {
							if (oauth.isDPoPNonceError(error)) {
								nonceRetried = true;
								const retryRes = await sendPAR();
								par = await tryProcess(retryRes);
							} else {
								throw error;
							}
						}
						if (!par.request_uri) {
							return {
								status: "fail",
								message: "Response missing request_uri",
								evidence: { actual: par },
							};
						}
						return {
							status: "pass",
							message: nonceRetried
								? `request_uri expires in ${par.expires_in}s (after DPoP-nonce retry)`
								: `request_uri expires in ${par.expires_in}s`,
							evidence: {
								response: { body: par },
								...(nonceRetried && {
									error: "AS required DPoP-nonce — retried with captured nonce",
								}),
							},
							patch: { requestUri: par.request_uri },
							result: par.request_uri,
						};
					} catch (error) {
						// oauth4webapi throws ResponseBodyError when the server returns
						// an OAuth error body (e.g. invalid_scope, invalid_request).
						// Surface the actual error code + description so the user/agent
						// sees what the PDS rejected.
						if (error instanceof oauth.ResponseBodyError) {
							const desc = (error.cause?.error_description as string) ?? "";
							return {
								status: "fail",
								message: `${error.error}: ${desc}`.trim().replace(/:$/, ""),
								evidence: {
									response: {
										status: error.status,
										body: error.cause,
									},
									error: `OAuth error: ${error.error}${desc ? ` — ${desc}` : ""}`,
								},
							};
						}
						return {
							status: "fail",
							message:
								error instanceof Error ? error.message : String(error),
							evidence: { error: String(error) },
						};
					}
				},
			);
			if (!requestUri) {
				haltAndSkipRest();
				return;
			}

			// 9b. Security probe: PAR must reject redirect_uri values that aren't
			// registered in the client metadata. RFC 6749 §3.1.2.4 / §10.6 — failing
			// this is an open-redirect / code-exfiltration vulnerability.
			await runStep(
				"flow.par-rejects-unregistered-redirect-uri",
				async () => {
					const evilRedirectUri =
						"https://pdscheck-probe.invalid/unregistered-redirect";
					const probeParams = {
						client_id: clientId(),
						redirect_uri: evilRedirectUri,
						response_type: "code",
						scope: activeScope,
						code_challenge: codeChallenge,
						code_challenge_method: "S256",
						state: oauth.generateRandomState(),
					};
					const attempt = async () => {
						const res = await oauth.pushedAuthorizationRequest(
							state.authServer!,
							{ client_id: clientId() },
							oauth.None(),
							probeParams,
							{ DPoP: dpop },
						);
						return await oauth.processPushedAuthorizationResponse(
							state.authServer!,
							{ client_id: clientId() },
							res,
						);
					};
					try {
						const accepted = await withNonceRetry(attempt);
						return {
							status: "fail",
							message:
								"AS accepted PAR with an unregistered redirect_uri — open-redirect / code-exfiltration risk (RFC 6749 §3.1.2.4)",
							evidence: {
								expected:
									"400 invalid_request (or similar) — unregistered redirect_uri rejected",
								actual: {
									request_uri_issued: accepted.request_uri,
									redirect_uri_probed: evilRedirectUri,
								},
								error:
									"AS issued a request_uri for a redirect not declared in the client metadata. This lets an attacker craft an authorization URL that completes at a different domain.",
							},
						};
					} catch (error) {
						if (error instanceof oauth.ResponseBodyError) {
							return {
								status: "pass",
								message: `correctly rejected: ${error.error}${error.cause?.error_description ? ` — ${error.cause.error_description}` : ""}`,
								evidence: {
									response: {
										status: error.status,
										body: error.cause,
									},
								},
							};
						}
						// Network error or unexpected throw — surface but don't fail
						return {
							status: "warn",
							message: `probe inconclusive: ${error instanceof Error ? error.message : String(error)}`,
							evidence: { error: String(error) },
						};
					}
				},
			);

			// 9c. Permission-set probes: only meaningful if the AS advertises any
			// `include:*` scope in scopes_supported. Skip otherwise.
			const advertisedScopes = (
				(state.authServer as Record<string, unknown> | undefined)
					?.scopes_supported as string[] | undefined
			)?.filter((s) => typeof s === "string") ?? [];
			const advertisedIncludes = advertisedScopes.filter((s) =>
				s.startsWith("include:"),
			);

			// 9c.i — request a clearly-nonexistent permission set. The AS should
			// reject with invalid_scope (or similar) once it tries to resolve.
			await runStep("flow.par-rejects-invalid-include", async () => {
				if (advertisedIncludes.length === 0) {
					return {
						status: "skip",
						message:
							"AS doesn't advertise any include:* scopes — permission set support not exercisable",
					};
				}
				const bogusInclude =
					"include:earth.cirrus.check.invalidnonexistentpermissionset";
				const probeParams = {
					client_id: clientId(),
					redirect_uri: redirectUri(),
					response_type: "code",
					scope: `atproto ${bogusInclude}`,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state: oauth.generateRandomState(),
				};
				const attempt = async () => {
					const res = await oauth.pushedAuthorizationRequest(
						state.authServer!,
						{ client_id: clientId() },
						oauth.None(),
						probeParams,
						{ DPoP: dpop },
					);
					return await oauth.processPushedAuthorizationResponse(
						state.authServer!,
						{ client_id: clientId() },
						res,
					);
				};
				try {
					const accepted = await withNonceRetry(attempt);
					return {
						status: "fail",
						message: `AS accepted an include: pointing at a nonexistent permission set — should have rejected with invalid_scope`,
						evidence: {
							expected:
								"invalid_scope error (the include: NSID doesn't resolve to a real permission set)",
							actual: {
								probed: bogusInclude,
								request_uri_issued: accepted.request_uri,
							},
						},
					};
				} catch (error) {
					if (error instanceof oauth.ResponseBodyError) {
						const isScopeError =
							error.error === "invalid_scope" ||
							error.error === "invalid_request";
						return {
							status: isScopeError ? "pass" : "warn",
							message: isScopeError
								? `correctly rejected: ${error.error}${error.cause?.error_description ? ` — ${error.cause.error_description}` : ""}`
								: `rejected, but with ${error.error} (expected invalid_scope)`,
							evidence: {
								response: { status: error.status, body: error.cause },
							},
						};
					}
					return {
						status: "warn",
						message: `probe inconclusive: ${error instanceof Error ? error.message : String(error)}`,
						evidence: { error: String(error) },
					};
				}
			});

			// 9c.ii — request the AS's OWN advertised include: scope. If the AS
			// advertises it in scopes_supported, it must be able to accept and
			// resolve it. Rejecting your own advertised scope is a real bug.
			await runStep("flow.par-accepts-advertised-include", async () => {
				if (advertisedIncludes.length === 0) {
					return {
						status: "skip",
						message:
							"AS doesn't advertise any include:* scopes — nothing to probe",
					};
				}
				const advertised = advertisedIncludes[0]!;
				const probeParams = {
					client_id: clientId(),
					redirect_uri: redirectUri(),
					response_type: "code",
					scope: `atproto ${advertised}`,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state: oauth.generateRandomState(),
				};
				const attempt = async () => {
					const res = await oauth.pushedAuthorizationRequest(
						state.authServer!,
						{ client_id: clientId() },
						oauth.None(),
						probeParams,
						{ DPoP: dpop },
					);
					return await oauth.processPushedAuthorizationResponse(
						state.authServer!,
						{ client_id: clientId() },
						res,
					);
				};
				try {
					const accepted = await withNonceRetry(attempt);
					return {
						status: "pass",
						message: `AS accepted its own advertised ${advertised} (request_uri expires in ${accepted.expires_in}s)`,
						evidence: {
							response: { body: accepted },
							actual: { probed: advertised },
						},
					};
				} catch (error) {
					if (error instanceof oauth.ResponseBodyError) {
						return {
							status: "fail",
							message: `AS rejected ${advertised} (its own advertised scope): ${error.error}${error.cause?.error_description ? ` — ${error.cause.error_description}` : ""}`,
							evidence: {
								response: { status: error.status, body: error.cause },
								error: `Permission set ${advertised} is listed in scopes_supported but PAR rejects it — the AS is advertising a scope it can't actually honor.`,
							},
						};
					}
					return {
						status: "warn",
						message: `probe inconclusive: ${error instanceof Error ? error.message : String(error)}`,
						evidence: { error: String(error) },
					};
				}
			});

			// 9c.iii — request a published permission set (`site.standard.authFull`)
			// that does NOT need to appear in scopes_supported. This tests whether
			// the AS can dynamically resolve `include:*` NSIDs via lexicon resolution.
			// An AS that only supports its own pre-advertised includes will fail here.
			await runStep("flow.par-accepts-known-permission-set", async () => {
				const knownInclude = "include:site.standard.authFull";
				const probeParams = {
					client_id: clientId(),
					redirect_uri: redirectUri(),
					response_type: "code",
					scope: `atproto ${knownInclude}`,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state: oauth.generateRandomState(),
				};
				const attempt = async () => {
					const res = await oauth.pushedAuthorizationRequest(
						state.authServer!,
						{ client_id: clientId() },
						oauth.None(),
						probeParams,
						{ DPoP: dpop },
					);
					return await oauth.processPushedAuthorizationResponse(
						state.authServer!,
						{ client_id: clientId() },
						res,
					);
				};
				try {
					const accepted = await withNonceRetry(attempt);
					return {
						status: "pass",
						message: `AS resolved site.standard.authFull (request_uri expires in ${accepted.expires_in}s)`,
						evidence: {
							response: { body: accepted },
							actual: { probed: knownInclude },
						},
					};
				} catch (error) {
					if (error instanceof oauth.ResponseBodyError) {
						return {
							status: "fail",
							message: `AS rejected ${knownInclude}: ${error.error}${error.cause?.error_description ? ` — ${error.cause.error_description}` : ""}`,
							evidence: {
								response: { status: error.status, body: error.cause },
								expected:
									"AS resolves the published lexicon and accepts the include:",
								actual: error.error,
								error:
									"site.standard.authFull is a published permission set lexicon. Rejecting it means this AS doesn't support dynamic lexicon-based permission-set resolution.",
							},
						};
					}
					return {
						status: "warn",
						message: `probe inconclusive: ${error instanceof Error ? error.message : String(error)}`,
						evidence: { error: String(error) },
					};
				}
			});

			// 10. Build authorization URL and persist state. Pause for user confirmation
			// rather than redirecting immediately, so they can review the pre-redirect steps.
			const authUrl = new URL(state.authServer!.authorization_endpoint!);
			authUrl.searchParams.set("client_id", clientId());
			authUrl.searchParams.set("request_uri", requestUri);
			await runStep("flow.build-authorization-url", async () => ({
				status: "pass",
				message: "ready to redirect — review and continue",
				evidence: { request: { method: "GET", url: authUrl.toString() } },
			}));

			await persistState({
				target,
				handle: resolved.handle,
				did: resolved.did,
				pds: resolved.pds,
				authServerUrl: state.authServerUrl!,
				codeVerifier,
				stateNonce,
				expectedIss: (state.authServer!.issuer as string) ?? "",
				scope: activeScope,
			});

			setState(
				produce((s) => {
					s.authUrl = authUrl.toString();
					s.phase = "ready-to-redirect";
				}),
			);
		} catch {
			// Mark any still-pending steps as skip
			for (let i = 0; i < state.steps.length; i++) {
				if (state.steps[i]!.status === "pending") {
					setState(
						"steps",
						i,
						produce((s) => {
							s.status = "skip";
							s.message = "previous step failed";
						}),
					);
				}
			}
			setState("phase", "done");
			setState("endedAt", Date.now());
		}
	})();

	return {
		state,
		cancel: () => {
			aborted = true;
		},
		redirect: () => {
			if (!state.authUrl) return;
			setState("phase", "redirecting");
			location.assign(state.authUrl);
		},
	};
}

export interface CallbackRun {
	state: FlowState;
}

export async function runPostCallback(): Promise<CallbackRun> {
	const persisted = loadPersistedState();
	const dpopKeyPair = await loadDpopKey();

	// Restore the scope chosen during pre-redirect — used by clientId() (which
	// embeds it in the loopback URL) and by boundary checks below.
	if (persisted?.scope) activeScope = persisted.scope;

	const initial = createFlowState(persisted?.target ?? "");
	// Mark pre-redirect steps complete
	for (const id of PRE_REDIRECT_STEPS) {
		const idx = initial.steps.findIndex((s) => s.id === id);
		if (idx >= 0) initial.steps[idx]!.status = "pass";
	}
	initial.phase = "post-callback";
	initial.handle = persisted?.handle;
	initial.did = persisted?.did;
	initial.pds = persisted?.pds;
	initial.authServerUrl = persisted?.authServerUrl;

	const [state, setState] = createStore<FlowState>(initial);

	const idxOf = (id: string) => state.steps.findIndex((s) => s.id === id);
	const setStep = (id: string, patch: Partial<FlowStep>) => {
		const i = idxOf(id);
		if (i < 0) return;
		setState(
			"steps",
			i,
			produce((s) => Object.assign(s, patch)),
		);
	};
	const runStep = async <T>(
		id: string,
		fn: () => Promise<{
			status: Exclude<StepStatus, "pending" | "running">;
			message?: string;
			evidence?: unknown;
			patch?: Partial<FlowState>;
			result?: T;
		}>,
	): Promise<T | undefined> => {
		setStep(id, { status: "running", startedAt: Date.now() });
		try {
			const out = await fn();
			if (out.patch)
				setState(produce((s) => Object.assign(s, out.patch)));
			setStep(id, {
				status: out.status,
				message: out.message,
				evidence: out.evidence,
				endedAt: Date.now(),
			});
			return out.result;
		} catch (error) {
			setStep(id, {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { error: String(error) },
				endedAt: Date.now(),
			});
		}
		return undefined;
	};

	void (async () => {
		if (!persisted || !dpopKeyPair) {
			for (const id of POST_CALLBACK_STEPS) {
				setStep(id, {
					status: "skip",
					message: "no persisted flow state — open a fresh flow from the landing page",
				});
			}
			setState("phase", "done");
			setState("endedAt", Date.now());
			return;
		}

		const params = new URLSearchParams(location.search);

		// 1. Callback params present
		await runStep("flow.callback-params-present", async () => {
			const code = params.get("code");
			const iss = params.get("iss");
			const stateParam = params.get("state");
			const error = params.get("error");
			if (error) {
				return {
					status: "fail",
					message: `OAuth error: ${error}: ${params.get("error_description") ?? ""}`,
					evidence: { error: String(params) },
				};
			}
			const missing: string[] = [];
			if (!code) missing.push("code");
			if (!iss) missing.push("iss");
			if (!stateParam) missing.push("state");
			if (missing.length > 0) {
				return {
					status: "fail",
					message: `missing: ${missing.join(", ")}`,
					evidence: { actual: Object.fromEntries(params) },
				};
			}
			return {
				status: "pass",
				message: "code, state, iss all present",
				evidence: { response: { body: Object.fromEntries(params) } },
			};
		});

		// 2. iss matches expected (RFC 9207)
		await runStep("flow.iss-matches", async () => {
			const iss = params.get("iss");
			if (iss === persisted.expectedIss) {
				return {
					status: "pass",
					message: iss,
				};
			}
			return {
				status: "fail",
				message: `expected ${persisted.expectedIss}, got ${iss}`,
				evidence: { expected: persisted.expectedIss, actual: iss },
			};
		});

		// 3. state matches
		await runStep("flow.state-matches", async () => {
			const stateParam = params.get("state");
			if (stateParam === persisted.stateNonce) {
				return {
					status: "pass",
					message: "state nonce matches",
				};
			}
			return {
				status: "fail",
				message: "state nonce mismatch (possible CSRF)",
				evidence: {
					expected: persisted.stateNonce,
					actual: stateParam,
				},
			};
		});

		// Re-fetch auth server (could re-use, but simpler to refetch)
		const issuerUrl = new URL(persisted.authServerUrl!);
		const discoveryRes = await oauth.discoveryRequest(issuerUrl, {
			algorithm: "oauth2",
		});
		const authServer = await oauth.processDiscoveryResponse(
			issuerUrl,
			discoveryRes,
		);
		setState("authServer", authServer);

		const dpop = oauth.DPoP({ [oauth.clockSkew]: 0 }, dpopKeyPair);

		// 4. Exchange code for tokens.
		// oauth4webapi requires the params be obtained from validateAuthResponse() —
		// that helper performs the state/iss/error checks first and returns a
		// "validated" URLSearchParams that the token-exchange call will accept.
		const tokenResp = await runStep<oauth.TokenEndpointResponse>(
			"flow.exchange-code",
			async () => {
				try {
					const validated = oauth.validateAuthResponse(
						authServer,
						{ client_id: clientId() },
						params,
						persisted.stateNonce,
					);
					const exchange = async () => {
						const res = await oauth.authorizationCodeGrantRequest(
							authServer,
							{ client_id: clientId() },
							oauth.None(),
							validated,
							redirectUri(),
							persisted.codeVerifier,
							{ DPoP: dpop },
						);
						return await oauth.processAuthorizationCodeResponse(
							authServer,
							{ client_id: clientId() },
							res,
						);
					};
					const parsed = await withNonceRetry(exchange);
					return {
						status: "pass",
						message: `token_type=${parsed.token_type}`,
						evidence: { response: { body: parsed } },
						patch: {
							accessToken: parsed.access_token,
							refreshToken: parsed.refresh_token,
							tokenType: parsed.token_type,
						},
						result: parsed,
					};
				} catch (error) {
					if (error instanceof oauth.ResponseBodyError) {
						const desc =
							(error.cause?.error_description as string) ?? "";
						return {
							status: "fail",
							message: `${error.error}: ${desc}`
								.trim()
								.replace(/:$/, ""),
							evidence: {
								response: { status: error.status, body: error.cause },
								error: `OAuth error: ${error.error}${desc ? ` — ${desc}` : ""}`,
							},
						};
					}
					return {
						status: "fail",
						message:
							error instanceof Error ? error.message : String(error),
						evidence: { error: String(error) },
					};
				}
			},
		);
		if (!tokenResp) {
			setState("phase", "done");
			setState("endedAt", Date.now());
			return;
		}

		// 5. Validate token response shape
		await runStep("flow.token-response-shape", async () => {
			const issues: string[] = [];
			if (!tokenResp.access_token) issues.push("access_token missing");
			if (tokenResp.token_type?.toLowerCase() !== "dpop")
				issues.push(
					`token_type must be "DPoP" (got ${tokenResp.token_type})`,
				);
			if (!tokenResp.refresh_token)
				issues.push("refresh_token missing (atproto requires)");
			if (typeof tokenResp.expires_in !== "number")
				issues.push("expires_in missing or not a number");
			if (tokenResp.scope === undefined)
				issues.push("scope echo missing (recommended)");
			if (issues.length === 0)
				return {
					status: "pass",
					message: `DPoP-bound, refresh=${tokenResp.refresh_token ? "yes" : "no"}, expires_in=${tokenResp.expires_in}s`,
				};
			return {
				status: issues.some(
					(i) =>
						i.includes("access_token") ||
						i.includes("token_type") ||
						i.includes("refresh_token") ||
						i.includes("expires_in"),
				)
					? "fail"
					: "warn",
				message:
					issues.length === 1 ? issues[0]! : `${issues.length} issues`,
				evidence: { error: issues.join("\n") },
			};
		});

		// 5b. Scope-echoed: verify the server returned the scope we asked for.
		// `include:*` scopes are permission-set references that the AS resolves
		// into expanded resource scopes — so if an include: was dropped AND new
		// scopes appeared, we treat that as legitimate expansion, not a bug.
		await runStep("flow.scope-echoed", async () => {
			const requested = activeScope;
			const granted = tokenResp.scope ?? "";
			if (!granted) {
				return {
					status: "warn",
					message: "token response omitted scope (RFC 6749 §5.1 OPTIONAL)",
					evidence: { expected: requested, actual: null },
				};
			}
			const requestedSet = new Set(requested.split(/\s+/).filter(Boolean));
			const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
			const dropped: string[] = [];
			const added: string[] = [];
			for (const s of requestedSet) if (!grantedSet.has(s)) dropped.push(s);
			for (const s of grantedSet) if (!requestedSet.has(s)) added.push(s);
			const droppedIncludes = dropped.filter((s) => s.startsWith("include:"));
			const droppedOther = dropped.filter((s) => !s.startsWith("include:"));
			if (dropped.length === 0 && added.length === 0) {
				return { status: "pass", message: granted };
			}
			const isPureExpansion =
				droppedOther.length === 0 &&
				droppedIncludes.length > 0 &&
				added.length > 0;
			if (isPureExpansion) {
				return {
					status: "pass",
					message: `expanded ${droppedIncludes.join(", ")} → ${added.length} resource scope${added.length === 1 ? "" : "s"}`,
					evidence: {
						expected: requested,
						actual: granted,
						actualDetail: {
							expanded: droppedIncludes,
							expansion: added,
						},
					},
				};
			}
			if (dropped.length === 0 && added.length > 0) {
				return {
					status: "fail",
					message: `server granted scopes we didn't ask for: ${added.join(", ")}`,
					evidence: {
						expected: requested,
						actual: granted,
						error: `unexpected additions: ${added.join(" ")}`,
					},
				};
			}
			return {
				status: "warn",
				message: `narrower than requested — dropped: ${droppedOther.join(", ") || dropped.join(", ")}`,
				evidence: {
					expected: requested,
					actual: granted,
					error: `dropped: ${dropped.join(" ")}\nadded: ${added.join(" ")}`,
				},
			};
		});

		// 6. Use access token: call getSession with DPoP
		const sessionData = await runStep<{
			did: string;
			handle: string;
		}>("flow.use-access-token", async () => {
			try {
				const res = await protectedFetchWithNonceRetry(
					tokenResp.access_token,
					"GET",
					new URL(`${persisted.pds}/xrpc/com.atproto.server.getSession`),
					new Headers(),
					null,
					{ DPoP: dpop },
				);
				if (!res.ok) {
					const detail = await readOAuthError(res);
					return {
						status: "fail",
						message: detail.message,
						evidence: {
							response: { status: res.status, body: detail.body },
							...(detail.wwwAuthenticate && {
								error: `WWW-Authenticate: ${detail.wwwAuthenticate}`,
							}),
						},
					};
				}
				const body = (await res.json()) as {
					did: string;
					handle: string;
				};
				return {
					status: "pass",
					message: `${body.handle} (${body.did})`,
					evidence: { response: { status: res.status, body } },
					result: body,
				};
			} catch (error) {
				return {
					status: "fail",
					message:
						error instanceof Error ? error.message : String(error),
					evidence: { error: String(error) },
				};
			}
		});

		// 7. Session DID matches
		if (sessionData) {
			await runStep("flow.session-did-matches", async () => {
				if (sessionData.did === persisted.did) {
					return { status: "pass", message: sessionData.did };
				}
				return {
					status: "fail",
					message: `expected ${persisted.did}, got ${sessionData.did}`,
					evidence: {
						expected: persisted.did,
						actual: sessionData.did,
					},
				};
			});
		} else {
			setStep("flow.session-did-matches", {
				status: "skip",
				message: "no session response",
			});
		}

		// 7b. Boundary tests: try writes inside/outside the granted scope.
		// Capture narrowed locals — closures below execute later and lose TS narrowing.
		const accessToken = tokenResp.access_token;
		const pdsUrl = persisted.pds!;
		const repoDid = persisted.did!;
		const createdUris: string[] = [];
		const grantedScope = tokenResp.scope ?? activeScope;
		const TEST_COLLECTION = "earth.cirrus.check.testrecord";

		async function tryCreateRecord(
			collection: string,
		): Promise<Response | { error: string }> {
			try {
				return await protectedFetchWithNonceRetry(
					accessToken,
					"POST",
					new URL(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`),
					new Headers({ "content-type": "application/json" }),
					JSON.stringify({
						repo: repoDid,
						collection,
						record: {
							$type: collection,
							message:
								"pdscheck OAuth conformance boundary test — safe to delete",
							verifier: location.origin,
							createdAt: new Date().toISOString(),
						},
					}),
					{ DPoP: dpop },
				);
			} catch (error) {
				return {
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// In-scope write: the granted scope should permit createRecord to the test collection.
		await runStep("flow.boundary-write-in-scope", async () => {
			const grants = scopeGrantsWriteTo(grantedScope, TEST_COLLECTION);
			if (!grants) {
				return {
					status: "skip",
					message: `granted scope (${grantedScope}) does not grant write to ${TEST_COLLECTION}`,
				};
			}
			const res = await tryCreateRecord(TEST_COLLECTION);
			if ("error" in res) {
				return {
					status: "fail",
					message: res.error,
					evidence: { error: res.error },
				};
			}
			const body = (await res.json().catch(() => ({}))) as {
				uri?: string;
				error?: string;
				message?: string;
			};
			if (!res.ok) {
				return {
					status: "fail",
					message: `${res.status} ${body.error ?? ""}: ${body.message ?? ""}`.trim(),
					evidence: { response: { status: res.status, body } },
				};
			}
			if (body.uri) createdUris.push(body.uri);
			return {
				status: "pass",
				message: body.uri ?? "created",
				evidence: { response: { status: res.status, body } },
			};
		});

		// Out-of-scope write: createRecord to a collection NOT covered by the granted scope.
		// If the granted scope is broad (transition:generic, repo:write), this is uninformative
		// because the write will succeed legitimately; skip with that note. Otherwise the PDS
		// should reject with insufficient_scope — anything else is a scope-enforcement bug.
		await runStep("flow.boundary-write-out-of-scope", async () => {
			const grantsOutOfScope = scopeGrantsWriteTo(
				grantedScope,
				OUT_OF_SCOPE_COLLECTION,
			);
			if (grantsOutOfScope) {
				return {
					status: "skip",
					message: `granted scope (${grantedScope}) is broad enough to write to ${OUT_OF_SCOPE_COLLECTION} — can't differentiate enforcement`,
				};
			}
			const res = await tryCreateRecord(OUT_OF_SCOPE_COLLECTION);
			if ("error" in res) {
				return {
					status: "fail",
					message: res.error,
					evidence: { error: res.error },
				};
			}
			const body = (await res.json().catch(() => ({}))) as {
				uri?: string;
				error?: string;
				message?: string;
			};
			if (res.ok) {
				if (body.uri) createdUris.push(body.uri);
				return {
					status: "fail",
					message: `write succeeded — PDS is not enforcing granular scope ${grantedScope}`,
					evidence: {
						expected: `insufficient_scope rejection for ${OUT_OF_SCOPE_COLLECTION}`,
						actual: body,
					},
				};
			}
			// Accept either OAuth canonical (RFC 6750, `insufficient_scope`) OR
			// the atproto-XRPC convention (`InsufficientScope`). Normalize by
			// lowercasing and stripping underscores so both forms collide.
			const wwwAuth = res.headers.get("www-authenticate") ?? "";
			const errorCode = String(body.error ?? "")
				.toLowerCase()
				.replace(/_/g, "");
			const headerSaysInsufficient = wwwAuth
				.toLowerCase()
				.includes("insufficient_scope");
			const bodySaysInsufficient = errorCode === "insufficientscope";
			if (bodySaysInsufficient || headerSaysInsufficient) {
				const usingAtprotoStyle =
					bodySaysInsufficient && body.error !== "insufficient_scope";
				return {
					status: "pass",
					message: usingAtprotoStyle
						? `correctly rejected (${res.status}, atproto-style ${body.error})`
						: `correctly rejected with insufficient_scope (${res.status})`,
					evidence: {
						response: {
							status: res.status,
							body,
						},
					},
				};
			}
			return {
				status: "warn",
				message: `rejected, but not as insufficient_scope: ${res.status} ${body.error ?? ""}`,
				evidence: {
					expected:
						'body.error to normalize to "insufficientscope" (OAuth insufficient_scope or atproto InsufficientScope)',
					actual: body,
				},
			};
		});

		// Cleanup any records we created during the boundary tests.
		await runStep("flow.boundary-cleanup", async () => {
			if (createdUris.length === 0) {
				return { status: "pass", message: "nothing to clean up" };
			}
			let deleted = 0;
			const stragglers: string[] = [];
			for (const uri of createdUris) {
				const m = uri.match(/^at:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
				if (!m) {
					stragglers.push(uri);
					continue;
				}
				const collection = m[1]!;
				const rkey = m[2]!;
				try {
					const res = await protectedFetchWithNonceRetry(
						accessToken,
						"POST",
						new URL(
							`${pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
						),
						new Headers({ "content-type": "application/json" }),
						JSON.stringify({
							repo: repoDid,
							collection,
							rkey,
						}),
						{ DPoP: dpop },
					);
					if (res.ok) deleted++;
					else stragglers.push(uri);
				} catch {
					stragglers.push(uri);
				}
			}
			if (stragglers.length > 0) {
				return {
					status: "warn",
					message: `${deleted} deleted, ${stragglers.length} stragglers`,
					evidence: { actual: stragglers },
				};
			}
			return { status: "pass", message: `${deleted} deleted` };
		});

		// 8. Refresh token
		const refreshedResp = tokenResp.refresh_token
			? await runStep<oauth.TokenEndpointResponse>(
					"flow.refresh-token",
					async () => {
						try {
							const refresh = async () => {
								const res = await oauth.refreshTokenGrantRequest(
									authServer,
									{ client_id: clientId() },
									oauth.None(),
									tokenResp.refresh_token!,
									{ DPoP: dpop },
								);
								return await oauth.processRefreshTokenResponse(
									authServer,
									{ client_id: clientId() },
									res,
								);
							};
							const parsed = await withNonceRetry(refresh);
							return {
								status: "pass",
								message: `new access_token issued, expires_in=${parsed.expires_in}s`,
								evidence: { response: { body: parsed } },
								result: parsed,
							};
						} catch (error) {
							if (error instanceof oauth.ResponseBodyError) {
								const desc =
									(error.cause?.error_description as string) ?? "";
								return {
									status: "fail",
									message: `${error.error}: ${desc}`
										.trim()
										.replace(/:$/, ""),
									evidence: {
										response: {
											status: error.status,
											body: error.cause,
										},
										error: `OAuth error: ${error.error}${desc ? ` — ${desc}` : ""}`,
									},
								};
							}
							return {
								status: "fail",
								message:
									error instanceof Error
										? error.message
										: String(error),
								evidence: { error: String(error) },
							};
						}
					},
				)
			: undefined;

		if (!tokenResp.refresh_token) {
			setStep("flow.refresh-token", {
				status: "skip",
				message: "no refresh_token in token response",
			});
		}

		// 9. Use refreshed token
		const tokenForCalls = refreshedResp?.access_token ?? tokenResp.access_token;
		if (refreshedResp) {
			await runStep("flow.use-refreshed-token", async () => {
				try {
					const res = await protectedFetchWithNonceRetry(
						refreshedResp.access_token,
						"GET",
						new URL(
							`${persisted.pds}/xrpc/com.atproto.server.getSession`,
						),
						new Headers(),
						null,
						{ DPoP: dpop },
					);
					if (!res.ok) {
						return {
							status: "fail",
							message: `HTTP ${res.status}`,
							evidence: { response: { status: res.status } },
						};
					}
					return {
						status: "pass",
						message: "refreshed token works",
					};
				} catch (error) {
					return {
						status: "fail",
						message:
							error instanceof Error
								? error.message
								: String(error),
						evidence: { error: String(error) },
					};
				}
			});
		} else {
			setStep("flow.use-refreshed-token", {
				status: "skip",
				message: "refresh did not succeed",
			});
		}

		// 10. Revoke token
		const revocationEndpoint = (
			authServer as Record<string, unknown>
		).revocation_endpoint as string | undefined;
		if (revocationEndpoint) {
			await runStep("flow.revoke-token", async () => {
				try {
					// Use oauth4webapi's revocationRequest — handles client auth
					// (None() for public clients) and request shape per RFC 7009.
					const res = await oauth.revocationRequest(
						authServer,
						{ client_id: clientId() },
						oauth.None(),
						tokenForCalls,
					);
					await oauth.processRevocationResponse(res);
					return {
						status: "pass",
						message: `HTTP ${res.status}`,
						evidence: { response: { status: res.status } },
					};
				} catch (error) {
					if (error instanceof oauth.ResponseBodyError) {
						const desc =
							(error.cause?.error_description as string) ?? "";
						return {
							status: "fail",
							message: `${error.error}: ${desc}`
								.trim()
								.replace(/:$/, ""),
							evidence: {
								response: { status: error.status, body: error.cause },
							},
						};
					}
					return {
						status: "fail",
						message:
							error instanceof Error
								? error.message
								: String(error),
						evidence: { error: String(error) },
					};
				}
			});

			// 11. Revoked token rejected (RFC 7009 §3: revoked tokens MUST
			// be invalidated; subsequent resource requests with the revoked
			// token MUST fail). Pause briefly before testing in case the AS
			// has any internal propagation delay.
			await new Promise((resolve) => setTimeout(resolve, 250));
			await runStep("flow.revoked-token-rejected", async () => {
				try {
					const res = await protectedFetchWithNonceRetry(
						tokenForCalls,
						"GET",
						new URL(
							`${persisted.pds}/xrpc/com.atproto.server.getSession`,
						),
						new Headers(),
						null,
						{ DPoP: dpop },
					);
					if (res.status === 401 || res.status === 403) {
						const detail = await readOAuthError(res);
						return {
							status: "pass",
							message: `HTTP ${res.status} — token correctly rejected (${detail.message})`,
							evidence: {
								response: { status: res.status, body: detail.body },
								...(detail.wwwAuthenticate && {
									error: `WWW-Authenticate: ${detail.wwwAuthenticate}`,
								}),
							},
						};
					}
					return {
						status: "fail",
						message: `expected 401/403, got ${res.status} — revoked token still grants access (RFC 7009 §3)`,
						evidence: {
							expected:
								"401 or 403 with invalid_token after revocation",
							actual: { status: res.status },
							error:
								"Resource server accepted a revoked token. Either revocation isn't actually invalidating the token, or the resource server isn't checking revocation status.",
						},
					};
				} catch (error) {
					return {
						status: "fail",
						message:
							error instanceof Error
								? error.message
								: String(error),
						evidence: { error: String(error) },
					};
				}
			});
		} else {
			setStep("flow.revoke-token", {
				status: "skip",
				message: "auth server doesn't advertise revocation_endpoint",
			});
			setStep("flow.revoked-token-rejected", {
				status: "skip",
				message: "revocation step skipped",
			});
		}

		// Clean up
		clearPersistedState();
		await clearDpopKey();
		setState("phase", "done");
		setState("endedAt", Date.now());
	})();

	return { state };
}

export function abandonFlow() {
	clearPersistedState();
	void clearDpopKey();
}
