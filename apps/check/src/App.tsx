import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { anonymousChecks, writeChecks } from "./checks";
import { OAuthFlowView } from "./components/OAuthFlowView";
import { RecentRuns } from "./components/RecentRuns";
import { RunView } from "./components/RunView";
import {
	completeCallback,
	getAgent,
	isCallbackPath,
	signOut,
	signedInDid,
	startLogin,
} from "./lib/oauth";
import {
	abandonFlow,
	isFlowCallback,
	runPostCallback,
	startPreRedirectFlow,
	type FlowRun,
	type FlowState,
} from "./lib/oauth-flow";
import { recordRun } from "./lib/recent";
import { startRun, type RunStore } from "./runner";
import type { CheckContext } from "./types";

const PLACEHOLDER = "jay.bsky.team";

const INTENT_KEY = "pdscheck.post-login-intent";
const TARGET_KEY = "pdscheck.post-login-target";

function initialTarget(): string {
	const params = new URLSearchParams(location.search);
	return (
		params.get("target") ?? params.get("pds") ?? params.get("handle") ?? ""
	);
}

function withViewTransition(fn: () => void) {
	if (
		typeof document !== "undefined" &&
		"startViewTransition" in document &&
		typeof document.startViewTransition === "function"
	) {
		document.startViewTransition(fn);
	} else {
		fn();
	}
}

type BootState =
	| { kind: "ready" }
	| { kind: "callback" }
	| { kind: "callback-error"; message: string }
	| { kind: "flow-callback"; state: FlowState };

type Mode = "landing" | "confirm-writes";

export function App() {
	// Both callback paths show the "completing sign-in" loading view first,
	// then transition to ready (atcute callback) or flow-callback (with state) once the
	// async handlers resolve.
	const initialBoot: BootState =
		isFlowCallback() || isCallbackPath()
			? { kind: "callback" }
			: { kind: "ready" };

	const [boot, setBoot] = createSignal<BootState>(initialBoot);
	const [flow, setFlow] = createSignal<FlowState | null>(null);
	const [flowRun, setFlowRun] = createSignal<FlowRun | null>(null);
	const [mode, setMode] = createSignal<Mode>("landing");
	const [target, setTarget] = createSignal(initialTarget());
	const [downloadCar, setDownloadCar] = createSignal(false);
	const [run, setRun] = createSignal<RunStore | null>(null);
	const [runMode, setRunMode] = createSignal<"verify" | "writes">("verify");
	const [authError, setAuthError] = createSignal<string | null>(null);

	onMount(() => {
		if (isFlowCallback()) {
			runPostCallback()
				.then(({ state }) => {
					setBoot({ kind: "flow-callback", state });
					setFlow(state);
				})
				.catch((error: unknown) => {
					setBoot({
						kind: "callback-error",
						message: error instanceof Error ? error.message : String(error),
					});
				});
		} else if (isCallbackPath()) {
			completeCallback()
				.then(async () => {
					const intent = sessionStorage.getItem(INTENT_KEY);
					const stashedTarget = sessionStorage.getItem(TARGET_KEY);
					sessionStorage.removeItem(INTENT_KEY);
					sessionStorage.removeItem(TARGET_KEY);
					if (stashedTarget) setTarget(stashedTarget);

					// User passed the confirmation step before signing in, so kick off
					// the run BEFORE transitioning out of the loading view — that way
					// they go straight from "COMPLETING SIGN IN" to RunView without a
					// landing-page flash.
					if (intent === "writes" && stashedTarget) {
						history.replaceState(
							null,
							"",
							`/?target=${encodeURIComponent(stashedTarget)}`,
						);
						await beginRun(stashedTarget, writeChecks, "writes");
					} else {
						history.replaceState(
							null,
							"",
							stashedTarget
								? `/?target=${encodeURIComponent(stashedTarget)}`
								: "/",
						);
					}
					setBoot({ kind: "ready" });
				})
				.catch((error: unknown) => {
					setBoot({
						kind: "callback-error",
						message: error instanceof Error ? error.message : String(error),
					});
				});
		}

		const onPop = () => {
			if (!new URLSearchParams(location.search).get("target")) {
				withViewTransition(() => {
					run()?.cancel();
					setRun(null);
				});
			}
		};
		window.addEventListener("popstate", onPop);
		onCleanup(() => {
			window.removeEventListener("popstate", onPop);
		});
	});

	createEffect(() => {
		const current = run();
		if (current?.endedAt) {
			recordRun(current);
			// Sessions are ephemeral — sign out at the end of any authenticated
			// run so the next test starts fresh (and possibly with a different
			// target account).
			if (signedInDid()) void signOut();
		}
	});

	function selectRecent(value: string) {
		setTarget(value);
		void beginRun(value, anonymousChecks);
	}

	async function beginRun(
		value: string,
		checks: readonly (typeof anonymousChecks)[number][],
		mode: "verify" | "writes" = "verify",
	) {
		const params = new URLSearchParams(location.search);
		params.set("target", value);
		history.pushState(null, "", `?${params.toString()}`);
		const agent = await getAgent();
		const initial: Partial<CheckContext> = {
			downloadCar: downloadCar(),
			...(agent ? { signedIn: true, agent } : {}),
		};
		setRunMode(mode);
		withViewTransition(() => {
			setRun(startRun(value, checks, initial));
		});
	}

	function cancelRun() {
		run()?.cancel();
		history.pushState(null, "", "/");
		withViewTransition(() => setRun(null));
	}

	function runReadChecks() {
		const value = target().trim();
		if (!value) return;
		void beginRun(value, anonymousChecks, "verify");
	}

	function startWriteTests() {
		const value = target().trim();
		if (!value) {
			setAuthError("Enter a handle first");
			return;
		}
		setAuthError(null);
		// Confirm BEFORE the redirect so the user sees what they're authorizing
		// before authenticating. Post-callback skips straight to the run.
		setMode("confirm-writes");
	}

	async function confirmWrites() {
		const value = target().trim();
		if (!value) {
			setAuthError("Enter a handle first");
			setMode("landing");
			return;
		}

		// Already signed in (rare — could happen on a same-target re-run before
		// auto-sign-out fired). Just start the run.
		if (signedInDid()) {
			setMode("landing");
			void beginRun(value, writeChecks, "writes");
			return;
		}

		// Not signed in — stash intent + target, redirect to PDS for auth.
		// Post-callback (in onMount) will read the intent and start the run.
		sessionStorage.setItem(INTENT_KEY, "writes");
		sessionStorage.setItem(TARGET_KEY, value);
		try {
			await startLogin(value);
		} catch (error) {
			if (error instanceof Error && error.message === "redirecting") return;
			sessionStorage.removeItem(INTENT_KEY);
			sessionStorage.removeItem(TARGET_KEY);
			setAuthError(error instanceof Error ? error.message : String(error));
			setMode("landing");
		}
	}

	function cancelWrites() {
		setMode("landing");
	}

	function startOAuthConformance() {
		const value = target().trim();
		if (!value) {
			setAuthError("Enter a handle first");
			return;
		}
		setAuthError(null);
		const run = startPreRedirectFlow(value);
		setFlow(run.state);
		setFlowRun(run);
	}

	function continueFlowRedirect() {
		flowRun()?.redirect();
	}

	function exitFlow() {
		abandonFlow();
		setFlow(null);
		setFlowRun(null);
		setBoot({ kind: "ready" });
		history.replaceState(null, "", "/");
	}

	async function onSignOut() {
		await signOut();
	}

	return (
		<Show when={boot().kind === "ready"} fallback={<BootView state={boot()} />}>
			<Show when={flow()} fallback={<Surface />}>
				{(state) => (
					<OAuthFlowView
						state={state()}
						onExit={exitFlow}
						onRedirect={continueFlowRedirect}
						onReadChecks={() => {
							const v = state().target.trim();
							exitFlow();
							if (v) void beginRun(v, anonymousChecks, "verify");
						}}
						onWriteTests={() => {
							const v = state().target.trim();
							exitFlow();
							if (v) {
								setTarget(v);
								void startWriteTests();
							}
						}}
					/>
				)}
			</Show>
		</Show>
	);

	function Surface() {
		return (
			<Show when={run()} fallback={<ModeSurface />}>
				{(activeRun) => (
					<RunView
						run={activeRun()}
						mode={runMode()}
						onCancel={cancelRun}
						onReadChecks={() => {
							const v = target().trim();
							if (v) void beginRun(v, anonymousChecks, "verify");
						}}
						onWriteTests={() => void startWriteTests()}
						onOAuthConformance={startOAuthConformance}
					/>
				)}
			</Show>
		);
	}

	function ModeSurface() {
		return (
			<Show when={mode() === "confirm-writes"} fallback={<Landing />}>
				<ConfirmWritesView
					target={target()}
					signedInDid={signedInDid()}
					onConfirm={confirmWrites}
					onCancel={cancelWrites}
				/>
			</Show>
		);
	}

	function BootView(props: { state: BootState }) {
		return (
			<Show
				when={
					props.state.kind === "flow-callback"
						? (props.state as Extract<BootState, { kind: "flow-callback" }>)
						: null
				}
				fallback={<CallbackView state={props.state} />}
			>
				{(flowBoot) => (
					<OAuthFlowView
						state={flowBoot().state}
						onExit={exitFlow}
						onRedirect={continueFlowRedirect}
						onReadChecks={() => {
							const v = flowBoot().state.target.trim();
							exitFlow();
							if (v) void beginRun(v, anonymousChecks, "verify");
						}}
						onWriteTests={() => {
							const v = flowBoot().state.target.trim();
							exitFlow();
							if (v) {
								setTarget(v);
								void startWriteTests();
							}
						}}
					/>
				)}
			</Show>
		);
	}

	function Landing() {
		return (
			<div class="min-h-dvh flex flex-col">
				<header class="px-6 py-4 flex items-center justify-between text-sm">
					<a href="/" class="flex items-center gap-2 no-underline">
						<span aria-hidden>☁️</span>
						<span class="font-bold tracking-[0.2em]">PDS CHECK</span>
					</a>
					<div class="flex items-center gap-4">
						<Show when={signedInDid()}>
							{(did) => (
								<span class="text-xs text-muted flex items-center gap-2">
									<span class="text-pass">●</span>
									<span class="truncate max-w-[18ch]">{did()}</span>
									<button
										type="button"
										onClick={onSignOut}
										class="text-faint hover:text-ink underline decoration-dotted underline-offset-4"
									>
										sign out
									</button>
								</span>
							)}
						</Show>
						<a
							href="https://github.com/ascorbic/cirrus"
							class="text-faint hover:text-ink"
						>
							ascorbic/cirrus
						</a>
					</div>
				</header>

				<main class="flex-1 grid place-items-center px-6 py-12">
					<div class="w-full max-w-md">
						<h1 class="font-bold tracking-[0.25em] text-2xl text-center mt-6">
							☁️ PDS CHECK
						</h1>

						<form onSubmit={(event) => event.preventDefault()} class="mt-10">
							<label for="target" class="sr-only">
								Handle, DID, or PDS URL
							</label>
							<input
								id="target"
								type="text"
								inputmode="url"
								autocomplete="off"
								autocapitalize="off"
								autocorrect="off"
								spellcheck={false}
								value={target()}
								onInput={(event) => setTarget(event.currentTarget.value)}
								placeholder={PLACEHOLDER}
								class="w-full border-2 border-ink bg-paper px-4 py-3 text-base placeholder:text-faint"
							/>
							<p class="mt-2 text-xs text-muted">
								handle (<code class="text-ink">alice.bsky.social</code>), DID (
								<code class="text-ink">did:plc:…</code>), or PDS URL (
								<code class="text-ink">https://pds.example.com</code> —
								server-only, no user context)
							</p>
						</form>

						<div class="mt-6 flex flex-col gap-2">
							<div class="border-2 border-ink">
								<button
									type="button"
									onClick={runReadChecks}
									class="group w-full px-4 py-3 text-left hover:bg-ink hover:text-paper transition-colors"
								>
									<div class="flex items-baseline justify-between gap-3">
										<span class="font-bold tracking-[0.15em]">
											READ-ONLY CHECKS →
										</span>
										<span class="text-xs text-faint group-hover:text-paper/70">
											anonymous, ~60 checks
										</span>
									</div>
									<div class="text-xs text-muted group-hover:text-paper/70 mt-1">
										identity resolution, repo reads, sync, blobs, firehose
										framing, OAuth discovery — no sign-in required
									</div>
								</button>
								<label class="flex items-start gap-2 text-xs text-muted cursor-pointer select-none px-4 py-2 border-t border-line">
									<input
										type="checkbox"
										checked={downloadCar()}
										onChange={(event) =>
											setDownloadCar(event.currentTarget.checked)
										}
										class="mt-0.5 accent-ink"
									/>
									<span>
										Also download the full repo CAR (warning: large repos can be
										hundreds of MB)
									</span>
								</label>
							</div>
							<button
								type="button"
								onClick={() => void startWriteTests()}
								class="group border-2 border-ink px-4 py-3 text-left hover:bg-ink hover:text-paper transition-colors"
							>
								<div class="flex items-baseline justify-between gap-3">
									<span class="font-bold tracking-[0.15em]">WRITE TESTS →</span>
									<span class="text-xs text-faint group-hover:text-paper/70">
										needs sign-in
									</span>
								</div>
								<div class="text-xs text-muted group-hover:text-paper/70 mt-1">
									createRecord, applyWrites, uploadBlob, deleteRecord
									roundtrips. Creates a few disposable records, deletes them
									after.
								</div>
							</button>
							<button
								type="button"
								onClick={startOAuthConformance}
								class="group border-2 border-ink px-4 py-3 text-left hover:bg-ink hover:text-paper transition-colors"
							>
								<div class="flex items-baseline justify-between gap-3">
									<span class="font-bold tracking-[0.15em]">
										OAUTH CONFORMANCE →
									</span>
									<span class="text-xs text-faint group-hover:text-paper/70">
										live OAuth flow
									</span>
								</div>
								<div class="text-xs text-muted group-hover:text-paper/70 mt-1">
									walks PAR + DPoP + PKCE + token exchange + refresh + revoke,
									surfaces every spec deviation, probes security edges
									(unregistered redirect_uri, scope enforcement).
								</div>
							</button>
							<Show when={authError()}>
								{(message) => (
									<div class="mt-2 text-xs text-fail text-center">
										{message()}
									</div>
								)}
							</Show>
						</div>

						<RecentRuns onSelect={selectRecent} />
					</div>
				</main>

				<footer class="px-6 py-4 text-xs text-faint flex justify-between">
					<span>no data leaves your browser</span>
					<a href="https://github.com/ascorbic/cirrus" class="hover:text-ink">
						source
					</a>
				</footer>
			</div>
		);
	}
}

function ConfirmWritesView(props: {
	target: string;
	signedInDid: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="min-h-dvh flex flex-col">
			<header class="px-6 py-4 flex items-center justify-between text-sm border-b border-line">
				<a href="/" class="flex items-center gap-2">
					<span aria-hidden>☁️</span>
					<span class="font-bold tracking-[0.2em]">CHECK</span>
				</a>
				<button
					type="button"
					onClick={props.onCancel}
					class="text-faint hover:text-ink text-xs"
				>
					cancel ×
				</button>
			</header>

			<main class="flex-1 grid place-items-center px-6 py-12">
				<div class="w-full max-w-xl">
					<div class="text-xs uppercase tracking-[0.2em] text-muted">
						Confirm write tests
					</div>
					<h1 class="text-lg font-bold break-all mt-1">{props.target}</h1>

					<Show
						when={props.signedInDid}
						fallback={
							<div class="mt-3 text-xs text-muted">
								you'll be redirected to your PDS to authorize before tests run
							</div>
						}
					>
						{(did) => (
							<div class="mt-3 text-xs text-muted">
								signed in as <span class="text-ink">{did()}</span>
							</div>
						)}
					</Show>

					<div class="mt-8 border-2 border-ink p-6 space-y-4 text-sm">
						<p>These tests will make real changes to your PDS. Specifically:</p>
						<ul class="space-y-2 pl-4">
							<li>
								<span class="text-ink">·</span> Create test records in
								collection{" "}
								<code class="bg-line/40 px-1 py-0.5">
									earth.cirrus.check.testrecord
								</code>
							</li>
							<li>
								<span class="text-ink">·</span> Round-trip read each created
								record (getRecord, listRecords)
							</li>
							<li>
								<span class="text-ink">·</span> Test{" "}
								<code class="bg-line/40 px-1 py-0.5">applyWrites</code> with an
								atomic create + delete
							</li>
							<li>
								<span class="text-ink">·</span> Upload a 67-byte test blob (1×1
								transparent PNG) via{" "}
								<code class="bg-line/40 px-1 py-0.5">uploadBlob</code>
							</li>
							<li>
								<span class="text-ink">·</span> Reference the blob in a second
								record
							</li>
							<li>
								<span class="text-ink">·</span> Delete every record created,
								leaving the collection empty
							</li>
						</ul>
						<p class="text-muted text-xs">
							The <code class="bg-line/40 px-1 py-0.5">earth.cirrus.check</code>{" "}
							namespace is isolated from{" "}
							<code class="bg-line/40 px-1 py-0.5">app.bsky.*</code> — records
							won't appear in Bluesky feeds, won't federate to the AppView, and
							can be safely deleted from your repo manually if any cleanup step
							fails. The session is signed out automatically when the run
							finishes.
						</p>
					</div>

					<div class="mt-6 flex gap-3">
						<button
							type="button"
							onClick={props.onCancel}
							class="border border-ink px-4 py-2 hover:bg-line/40 transition-colors"
						>
							cancel
						</button>
						<button
							type="button"
							onClick={props.onConfirm}
							class="flex-1 border-2 border-ink bg-ink text-paper px-4 py-2 font-bold tracking-[0.15em] hover:bg-paper hover:text-ink transition-colors"
						>
							{props.signedInDid ? "RUN WRITE TESTS →" : "AUTHORIZE + RUN →"}
						</button>
					</div>
				</div>
			</main>
		</div>
	);
}

function CallbackView(props: { state: BootState }) {
	return (
		<div class="min-h-dvh grid place-items-center px-6">
			<div class="text-center max-w-md">
				<div class="text-6xl" aria-hidden>
					☁️
				</div>
				<Show
					when={props.state.kind === "callback-error"}
					fallback={
						<>
							<p class="mt-6 font-bold tracking-[0.2em] text-sm">
								COMPLETING SIGN IN
							</p>
							<p class="mt-2 text-xs text-muted">
								exchanging authorization code for a session…
							</p>
						</>
					}
				>
					<p class="mt-6 font-bold tracking-[0.2em] text-sm text-fail">
						SIGN IN FAILED
					</p>
					<p class="mt-2 text-xs text-muted">
						{props.state.kind === "callback-error" && props.state.message}
					</p>
					<a
						href="/"
						class="inline-block mt-6 text-xs underline decoration-dotted underline-offset-4 hover:text-ink"
					>
						return home →
					</a>
				</Show>
			</div>
		</div>
	);
}
