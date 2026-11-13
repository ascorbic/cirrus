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
	/**
	 * - `lexicon`: a vendored lexicon (machine-checked by the coverage
	 *   generator).
	 * - `proposal` / `pds-design-spec`: the upstream prose specs.
	 * - `changeset`: an upstream changeset (`.changeset/<name>.md` on the
	 *   alpha branch). For alpha protocol mechanics no lexicon can express —
	 *   the credential HTTP signature, the MAC exchange, key discovery — the
	 *   changeset is the alpha's only normative prose, so it is a citable
	 *   source for a `must`.
	 * - `reference`: what the reference implementation happens to do. Fine
	 *   for a `should`; never enough on its own for a `must`.
	 */
	source:
		| "lexicon"
		| "proposal"
		| "pds-design-spec"
		| "changeset"
		| "reference";
	/**
	 * Locator within the source: a lexicon id (optionally `#def` or
	 * `@error:Name`), a proposal section anchor, a design-spec heading or a
	 * changeset name. Lexicon locators are machine-checked by the coverage
	 * generator.
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
 * - `syncer-inbox`: an endpoint the harness serves that the target can
 *   reach — registered as a syncer's `notify` endpoint, and named (through
 *   a resolvable `did#serviceId`) as a `managedspace` managing app.
 * - `pds-blobs`: the target is a full PDS implementing
 *   `com.atproto.repo.uploadBlob` and `com.atproto.sync.getBlob` — needed
 *   to prove a space blob is not served publicly. A standalone space host,
 *   or an isolated space-routes fixture, does not provide it.
 * - `pds-delegation`: the target implements
 *   `com.atproto.space.getDelegationToken`, so the operator can obtain a
 *   credential for its own non-public space (the self-flow) with no
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

/**
 * An identity the harness controls: a DID the target can resolve, plus the
 * key behind its `#atproto` verification method. The harness signs as this
 * party — delegation tokens as a reader, service auth as a writer's PDS,
 * credentials and revocations as a foreign space authority.
 */
export interface HarnessIdentity {
	did: string;
	/** Sign bytes with the identity's `#atproto` key (ES256K/ES256), compact. */
	sign(bytes: Uint8Array): Promise<Uint8Array>;
	/** JWT `alg` for {@link sign}. */
	jwtAlg: string;
}

export interface IdentityProvider {
	/** Mint (or reuse) a harness identity by role label. */
	identity(role: string): Promise<HarnessIdentity>;
}

/**
 * A syncer endpoint the harness serves: the `notify` target of
 * `authorizeSpaceSync`, which the space host calls back with
 * `com.atproto.space.confirmRegistration` and `notifySpaceUpdate`. The
 * same endpoint doubles as a `managedspace` managing app answering
 * `com.atproto.managedspace.checkAccess`.
 *
 * `createSyncerInbox()` implements all of this over a fetch-style handler;
 * a harness only has to route requests for `endpoint` to it.
 */
export interface SyncerInbox {
	/** The base URL registered as `notify.endpoint` (`{endpoint}/xrpc/...`). */
	endpoint: string;
	/**
	 * A `did#serviceId` reference whose DID document routes that service to
	 * `endpoint`, for naming the inbox as a managing app. The target sends
	 * service auth addressed to it.
	 */
	service: string;
	/**
	 * Issue a fresh notify token for `space`. The inbox confirms a
	 * registration (echoes the challenge) and accepts notifications only for
	 * tokens it issued for that space; anything else is refused with 400.
	 */
	issueToken(space: string): string;
	/** Wait for a delivery matching the predicate, or time out (null). */
	waitFor(
		predicate: (delivery: InboxDelivery) => boolean,
		timeoutMs: number,
	): Promise<InboxDelivery | null>;
	/**
	 * Answer queries for `lxm` (e.g. `com.atproto.managedspace.checkAccess`)
	 * with the handler's JSON body; pass undefined to stop answering. Queries
	 * are recorded as deliveries either way.
	 */
	respond(
		lxm: string,
		handler: ((delivery: InboxDelivery) => unknown) | undefined,
	): void;
}

export interface InboxDelivery {
	lxm: string;
	/** Parsed JSON body of a procedure. */
	body: unknown;
	/** Query parameters of a query. */
	params?: Record<string, string>;
	authorization?: string;
	/** The HTTP status the inbox answered with. */
	status: number;
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
	/**
	 * The PLC directory did:plc identities resolve against (the target's own
	 * and the repos it reads). Defaults to https://plc.directory.
	 */
	plcDirectory?: string;
}

export interface CheckContext {
	target: Target;
	fetch: typeof fetch;
	/**
	 * Present when the harness has an authenticated session on the target.
	 * Provide `authorize` when auth is plain header injection (a bearer
	 * token), or `fetch` when each request must be individually signed — an
	 * OAuth session's DPoP proof depends on the method and URL, so it cannot
	 * be expressed as headers alone. At least one is required;
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
	 * Resolve a DID document. Optional: by default the suite fetches did:web
	 * documents from their host and did:plc documents from
	 * `target.plcDirectory`, over `fetch`. An in-process fixture with its own
	 * resolution supplies this instead.
	 */
	resolveDid?(did: string): Promise<unknown>;
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
	/** Overrides the runner's per-check timeout (for slow checks). */
	timeoutMs?: number;
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
