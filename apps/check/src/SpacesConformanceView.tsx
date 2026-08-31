/**
 * Runner #3: the browser adapter for the spaces conformance suite.
 *
 * Signed in (the landing-page flow), the run carries the operator, blob
 * and delegation capabilities: probe spaces, record writes, applyWrites
 * atomicity, blob isolation and the operator's own delegation → credential
 * → read flow all execute for real against the user's PDS, authenticated
 * through the DPoP-bound OAuth session. Results stream into the table as
 * each check lands.
 *
 * The checks a browser genuinely cannot run — harness-held foreign
 * identities, the alpha crypto libs — are not shown at all: a row (or a
 * count) implies a way they could have run here, and there isn't one.
 * They are covered by the CLI and vitest runners.
 *
 * Without a session it degrades to the anonymous slice (discovery and
 * unauthenticated request shapes) against any host the user names.
 */

import { createSignal, For, onMount, Show } from "solid-js";
import {
	browserCatalog,
	filterCatalog,
	operatorChecks,
	runChecks,
	type CheckContext,
	type CheckResult,
	type RunReport,
} from "@getcirrus/space-conformance";
import type { OAuthUserAgent } from "@atcute/oauth-browser-client";
import { getAgent, signOut, signedInDid } from "./lib/oauth";

function normalizeOrigin(input: string): string {
	const trimmed = input.trim().replace(/\/+$/, "");
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

async function resolveDid(origin: string): Promise<string> {
	const res = await fetch(`${origin}/.well-known/did.json`);
	if (!res.ok) throw new Error(`did.json returned ${res.status}`);
	const doc = (await res.json()) as { id?: string };
	if (!doc.id) throw new Error("did.json has no id");
	return doc.id;
}

/**
 * A fetch that routes same-origin requests through the OAuth agent (which
 * signs each one with the session's DPoP key) and everything else through
 * the plain window fetch. The conformance context keeps its bare `fetch`
 * for the requests that must stay anonymous.
 */
function agentFetch(agent: OAuthUserAgent, origin: string): typeof fetch {
	return (input, init) => {
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url,
		);
		if (url.origin === origin) {
			return agent.handle(url.pathname + url.search, init);
		}
		return fetch(input, init);
	};
}

const STATUS_STYLE: Record<CheckResult["status"], string> = {
	pass: "text-pass",
	fail: "text-fail",
	error: "text-fail",
	skipped: "text-faint",
};
const STATUS_ICON: Record<CheckResult["status"], string> = {
	pass: "✓",
	fail: "✗",
	error: "!",
	skipped: "–",
};

export function SpacesConformanceView(props: { onExit: () => void }) {
	const [target, setTarget] = createSignal("");
	const [running, setRunning] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [results, setResults] = createSignal<CheckResult[]>([]);
	const [report, setReport] = createSignal<RunReport | null>(null);
	const [authedRun, setAuthedRun] = createSignal(false);

	async function runCatalog(
		context: Omit<CheckContext, "state" | "log">,
		capabilities: Parameters<typeof filterCatalog>[1],
	) {
		setRunning(true);
		setError(null);
		setResults([]);
		setReport(null);
		try {
			const filtered = filterCatalog(browserCatalog, capabilities);
			const result = await runChecks({
				catalog: filtered,
				context,
				suiteVersion: "web",
				alphaBuild: "0.0.0-spaces-alpha-20260818163953",
				// Stream rows into the table as checks land. Skipped results
				// are checks this transport can never run — not listing them
				// avoids implying they could have; the footer counts them.
				onResult: (result) => {
					if (result.status !== "skipped") {
						setResults((prev) => [...prev, result]);
					}
				},
			});
			setReport(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	}

	async function runAuthed(agent: OAuthUserAgent) {
		const origin = normalizeOrigin(agent.session.info.aud);
		const did = agent.session.info.sub;
		setAuthedRun(true);
		setTarget(origin);
		await runCatalog(
			{
				target: { origin, did },
				fetch: window.fetch.bind(window),
				operator: {
					oauth: true,
					fetch: agentFetch(agent, origin),
				},
			},
			{
				capabilities: ["operator", "pds-blobs", "pds-delegation"],
				destructive: true,
			},
		);
		// Sessions are ephemeral — sign out once the run has finished, the
		// same convention as the write tests.
		if (signedInDid()) void signOut();
	}

	async function onRunAnonymous(event: Event) {
		event.preventDefault();
		const raw = target().trim();
		if (!raw) return;
		setAuthedRun(false);
		try {
			const origin = normalizeOrigin(raw);
			const did = await resolveDid(origin);
			await runCatalog(
				{
					target: { origin, did, implementation: origin },
					fetch: window.fetch.bind(window),
				},
				{ capabilities: [] },
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	onMount(() => {
		// Arriving from the landing flow the user has just authorized; run
		// immediately against their own PDS. With no session this is the
		// anonymous surface and waits for a target instead.
		void getAgent().then((agent) => {
			if (agent) void runAuthed(agent);
		});
	});

	// In an anonymous run, the operator checks were skipped but WOULD run
	// with a sign-in — worth a pointer. (The alpha-lib/identity checks are
	// deliberately not mentioned at all: they never run in a browser.)
	const operatorIds = new Set(operatorChecks.map((c) => c.id));
	const signInWouldRun = () =>
		(report()?.results ?? []).filter(
			(r) => r.status === "skipped" && operatorIds.has(r.id),
		).length;

	return (
		<div class="min-h-dvh flex flex-col">
			<header class="px-6 py-4 flex items-center justify-between text-sm">
				<button
					type="button"
					onClick={props.onExit}
					class="flex items-center gap-2 no-underline text-faint hover:text-ink"
				>
					<span aria-hidden>←</span>
					<span class="font-bold tracking-[0.2em]">PDS CHECK</span>
				</button>
				<span class="text-xs text-muted">spaces conformance (alpha)</span>
			</header>

			<main class="flex-1 px-6 py-8 w-full max-w-2xl mx-auto">
				<h1 class="font-bold tracking-[0.2em] text-xl">SPACES CONFORMANCE</h1>
				<p class="text-sm text-muted mt-2">
					<Show
						when={authedRun()}
						fallback={
							<>
								Discovery and request-shape checks against a live spaces host.
								Sign in from the landing page to run the write, blob and
								credential checks against your own PDS.
							</>
						}
					>
						Running the operator checks against{" "}
						<span class="text-ink">{target()}</span>: probe spaces, record
						writes, blob isolation and the delegation → credential → read flow.
					</Show>
				</p>

				<Show when={!authedRun()}>
					<form onSubmit={onRunAnonymous} class="mt-6 flex gap-2">
						<input
							type="text"
							placeholder="pds.example.com"
							value={target()}
							onInput={(e) => setTarget(e.currentTarget.value)}
							class="flex-1 rounded border border-faint bg-transparent px-3 py-2 text-sm"
						/>
						<button
							type="submit"
							disabled={running()}
							class="rounded border border-faint px-4 py-2 text-sm hover:text-ink disabled:opacity-50"
						>
							{running() ? "running…" : "run"}
						</button>
					</form>
				</Show>

				<Show when={error()}>
					{(message) => (
						<p class="mt-4 text-sm text-fail">Could not run: {message()}</p>
					)}
				</Show>

				<Show when={results().length > 0 || running()}>
					<div class="mt-8">
						<Show
							when={report()}
							fallback={
								<div class="text-xs text-muted" aria-live="polite">
									running… {results().length} checks completed
								</div>
							}
						>
							{(r) => (
								<div class="text-xs text-muted">
									{r().summary.pass} pass · {r().summary.fail} fail ·{" "}
									{r().summary.error} errored · alpha {r().alphaBuild}
								</div>
							)}
						</Show>
						<ul class="mt-3 divide-y divide-faint/30">
							<For each={results()}>
								{(result) => (
									<li class="py-2 flex items-start gap-3 text-sm">
										<span class={STATUS_STYLE[result.status]}>
											{STATUS_ICON[result.status]}
										</span>
										<div class="flex-1">
											<div class="flex items-center gap-2">
												<span class="font-mono text-xs">{result.id}</span>
												<span class="text-[10px] uppercase text-faint">
													{result.tier}
												</span>
											</div>
											<div class="text-xs text-muted">{result.detail}</div>
										</div>
									</li>
								)}
							</For>
							<Show when={running()}>
								<li class="py-2 flex items-start gap-3 text-sm text-faint">
									<span class="animate-pulse">…</span>
									<span class="text-xs">running next check</span>
								</li>
							</Show>
						</ul>
						<Show when={!running() && signInWouldRun() > 0}>
							<p class="mt-4 text-xs text-faint">
								{signInWouldRun()} more checks need an authenticated session —
								start from SPACES CONFORMANCE on the landing page to run them
								against your own PDS.
							</p>
						</Show>
					</div>
				</Show>
			</main>
		</div>
	);
}
