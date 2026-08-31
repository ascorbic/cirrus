/**
 * The check model.
 *
 * A check is a black-box probe of a live spaces implementation: an async
 * function over a transport, plus machine-readable metadata that says what
 * it tests, on whose authority, and what it needs from the harness.
 *
 * Tiers, and why they matter: a conformance suite that fails
 * implementations on its author's opinions poisons its own authority.
 * Every `must` check cites specified behavior — a lexicon shape, a
 * declared error name, a requirement in the proposal or the upstream PDS
 * design spec. `should` checks encode reference-implementation behavior
 * the spec leaves open, and are calibrated by running this suite against
 * the reference: a `should` the reference fails is stale by definition.
 * `info` checks report implementation choices and never fail anyone.
 */

export type Tier = "must" | "should" | "info";

/** Where a check's claim comes from. Every `must` check needs at least one. */
export interface Citation {
	/** e.g. "lexicon", "proposal", "pds-design-spec", "reference" */
	source: "lexicon" | "proposal" | "pds-design-spec" | "reference";
	/**
	 * Locator within the source: a lexicon id (optionally `#def` or
	 * `@error:Name`), a proposal section anchor, or a design-spec heading.
	 * Lexicon locators are machine-checked by the coverage generator.
	 */
	ref: string;
}

/**
 * What the harness must supply for a check to run. A runner skips (and
 * reports as "not testable") any check whose needs it cannot meet.
 *
 * - `operator`: an authenticated session on the target (any full-access
 *   scheme; how it was obtained is the harness's business).
 * - `oauth-session`: specifically an OAuth-granted session with `space:`
 *   scopes — only harnesses that can drive the target's consent flow.
 * - `identities`: harness-controlled DIDs with resolvable documents and
 *   held keys, for playing reader/writer roles.
 * - `syncer-inbox`: an HTTPS endpoint the harness controls that the
 *   target can deliver notifications to.
 * - `pds-blobs`: the target is a full PDS implementing
 *   `com.atproto.repo.uploadBlob` and `com.atproto.sync.getBlob` — needed
 *   to prove a space blob is not served publicly. A standalone space host,
 *   or an isolated space-routes fixture, does not provide it.
 * - `pds-delegation`: the target implements
 *   `com.atproto.space.getDelegationToken`, so the operator can obtain a
 *   credential for its own space (the bulletin self-flow) with no
 *   harness-held reader key. A space-routes fixture does not provide it.
 * - `alpha-libs`: the transport can execute the alpha crypto libraries
 *   (`@atproto/space`), whose bundle pulls node-only dependencies. Real
 *   checks never declare it — importing the full entry implies it — but
 *   the browser catalog's metadata stubs do, so a browser harness (which
 *   never declares it) reports them "not testable here" instead of
 *   running a stub.
 */
export type Capability =
	| "operator"
	| "oauth-session"
	| "identities"
	| "syncer-inbox"
	| "pds-blobs"
	| "pds-delegation"
	| "alpha-libs";

export type CheckStatus =
	| "pass"
	| "fail"
	| "skipped" // capability not available, or filtered out
	| "error"; // the check itself broke; distinct from a failing target

export interface CheckResult {
	id: string;
	tier: Tier;
	status: CheckStatus;
	/** One line: what was observed, or why skipped/errored. */
	detail: string;
	citations: Citation[];
	/** Optional request/response evidence for the report. */
	evidence?: unknown;
	durationMs?: number;
}

/** An identity the harness controls: a resolvable DID plus its keys. */
export interface HarnessIdentity {
	did: string;
	/** Sign bytes with the identity's atproto signing key (ES256K/ES256). */
	sign(bytes: Uint8Array): Promise<Uint8Array>;
	/** JWT `alg` for {@link sign}. */
	jwtAlg: string;
}

/** A DPoP key the harness controls (always ES256, per the proposal). */
export interface DpopKey {
	bareJwk: Record<string, unknown>;
	/** Algorithms the key supports; `["ES256"]` for DPoP. */
	algorithms: readonly string[];
	/** RFC 7638 thumbprint of {@link bareJwk}. */
	jkt: string;
	createJwt(
		header: Record<string, unknown>,
		payload: Record<string, unknown>,
	): Promise<string>;
}

export interface IdentityProvider {
	/** Mint (or reuse) a harness identity by role label. */
	identity(role: string): Promise<HarnessIdentity>;
	/** Mint a fresh DPoP key. */
	dpopKey(): Promise<DpopKey>;
}

export interface SyncerInbox {
	/** The service identifier to register (did, optionally with #fragment). */
	service: string;
	/** Wait for a delivery matching the predicate, or time out (null). */
	waitFor(
		predicate: (delivery: InboxDelivery) => boolean,
		timeoutMs: number,
	): Promise<InboxDelivery | null>;
}

export interface InboxDelivery {
	lxm: string;
	body: unknown;
	authorization?: string;
	receivedAt: number;
}

/** Description of the implementation under test. */
export interface Target {
	/** Public origin, e.g. https://pds.example.com */
	origin: string;
	/** The DID whose repos / spaces the target serves. */
	did: string;
	/** Free-form implementation label for the report ("cirrus", "reference"). */
	implementation?: string;
}

export interface CheckContext {
	target: Target;
	fetch: typeof fetch;
	/**
	 * Present when the harness has an authenticated session on the target.
	 * Provide `authorize` when auth is plain header injection (a bearer
	 * token), or `fetch` when each request must be individually signed — a
	 * DPoP-bound OAuth session, where the proof depends on the method and
	 * URL, cannot be expressed as headers alone. At least one is required;
	 * `fetch` wins when both are present.
	 */
	operator?: {
		/** Add auth to a request (header injection). */
		authorize?(init: RequestInit & { headers: Headers }): Promise<void>;
		/** A fetch that carries the operator's credentials on every request. */
		fetch?: typeof fetch;
		/** True when this session came from an OAuth grant with space: scopes. */
		oauth: boolean;
	};
	identities?: IdentityProvider;
	syncerInbox?: SyncerInbox;
	/**
	 * Scratch space shared across checks in one run — e.g. the probe space
	 * a setup check created, reused by later checks. Keys are namespaced by
	 * convention (`"probe.space.uri"`).
	 */
	state: Map<string, unknown>;
	/** Structured logging into the run report. */
	log(message: string): void;
}

export interface Check {
	id: string;
	title: string;
	tier: Tier;
	citations: Citation[];
	needs: Capability[];
	/** Creates or deletes state on the target (probe spaces, records). */
	destructive?: boolean;
	/** Depends on real time passing (expiry windows); excluded by default. */
	slow?: boolean;
	run(ctx: CheckContext): Promise<CheckOutcome>;
}

/** What a check's run() returns; the runner wraps it into a CheckResult. */
export interface CheckOutcome {
	status: "pass" | "fail";
	detail: string;
	evidence?: unknown;
}

export const pass = (detail: string, evidence?: unknown): CheckOutcome => ({
	status: "pass",
	detail,
	...(evidence !== undefined ? { evidence } : {}),
});

export const fail = (detail: string, evidence?: unknown): CheckOutcome => ({
	status: "fail",
	detail,
	...(evidence !== undefined ? { evidence } : {}),
});
