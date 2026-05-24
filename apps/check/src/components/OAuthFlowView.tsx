import { For, Show, createMemo, createSignal } from "solid-js";
import type { FlowState, FlowStep } from "../lib/oauth-flow";
import { specUrlFor } from "../lib/spec-urls";
import { StatusGlyph } from "./StatusGlyph";

function durationOf(step: FlowStep): string {
	if (!step.startedAt || !step.endedAt) return "";
	const ms = step.endedAt - step.startedAt;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function downloadString(filename: string, content: string, mime: string) {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

function renderFlowFinding(step: FlowStep, lines: string[]) {
	lines.push(`### ${step.label}`);
	lines.push("");
	lines.push(`- **Step ID:** \`${step.id}\``);
	lines.push(`- **Status:** ${step.status}`);
	const spec = specUrlFor(step.id);
	if (spec) lines.push(`- **Spec:** ${spec}`);
	if (step.message) lines.push(`- **Message:** ${step.message}`);
	if (step.startedAt && step.endedAt) {
		lines.push(`- **Duration:** ${step.endedAt - step.startedAt}ms`);
	}
	lines.push("");
	if (step.evidence) {
		lines.push("**Evidence:**");
		lines.push("");
		lines.push("```json");
		lines.push(JSON.stringify(step.evidence, null, 2));
		lines.push("```");
		lines.push("");
	}
}

function generateFlowFindingsMarkdown(state: FlowState): string {
	const failures = state.steps.filter((s) => s.status === "fail");
	const warnings = state.steps.filter((s) => s.status === "warn");
	const passed = state.steps.filter((s) => s.status === "pass").length;
	const skipped = state.steps.filter((s) => s.status === "skip").length;

	const lines: string[] = [];
	lines.push("# OAuth conformance flow findings");
	lines.push("");
	lines.push(`**Target:** \`${state.target}\`  `);
	if (state.handle) lines.push(`**Handle:** \`${state.handle}\`  `);
	if (state.did) lines.push(`**DID:** \`${state.did}\`  `);
	if (state.pds) lines.push(`**PDS:** \`${state.pds}\`  `);
	if (state.authServerUrl)
		lines.push(`**Auth server:** \`${state.authServerUrl}\`  `);
	lines.push(`**Run started:** ${new Date(state.startedAt).toISOString()}  `);
	if (state.endedAt) {
		lines.push(`**Run ended:** ${new Date(state.endedAt).toISOString()}  `);
	}
	lines.push(`**Verifier:** ${location.origin}  `);
	lines.push("");
	lines.push(
		"> **For agents:** each finding below describes a behavioral conformance issue observed " +
			"during a real OAuth dance against the target PDS. Use the evidence (HTTP requests/responses, " +
			"oauth4webapi error codes, scope strings) to diagnose. atproto OAuth spec lives at " +
			"https://atproto.com/specs/oauth and the implementation reference is `oauth4webapi` " +
			"+ `@atproto/oauth-scopes`.",
	);
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push(
		`- **${failures.length}** failure${failures.length === 1 ? "" : "s"}`,
	);
	if (warnings.length > 0) {
		lines.push(
			`- **${warnings.length}** warning${warnings.length === 1 ? "" : "s"}`,
		);
	}
	lines.push(`- ${passed} passed`);
	if (skipped > 0) lines.push(`- ${skipped} skipped`);
	lines.push(`- ${state.steps.length} steps total`);
	lines.push("");

	if (failures.length === 0 && warnings.length === 0) {
		lines.push("No failures or warnings — every applicable step passed.");
		return lines.join("\n");
	}

	if (failures.length > 0) {
		lines.push("## Failures");
		lines.push("");
		for (const s of failures) renderFlowFinding(s, lines);
	}

	if (warnings.length > 0) {
		lines.push("## Warnings");
		lines.push("");
		for (const s of warnings) renderFlowFinding(s, lines);
	}

	return lines.join("\n");
}

function downloadFlowFindings(state: FlowState) {
	const slug = (state.target || "oauth-flow").replace(/[^a-z0-9.-]/gi, "_");
	downloadString(
		`pdscheck-${slug}-${state.startedAt}-oauth-flow-findings.md`,
		generateFlowFindingsMarkdown(state),
		"text/markdown",
	);
}

function downloadFlowJson(state: FlowState) {
	const slug = (state.target || "oauth-flow").replace(/[^a-z0-9.-]/gi, "_");
	const payload = {
		target: state.target,
		handle: state.handle,
		did: state.did,
		pds: state.pds,
		authServerUrl: state.authServerUrl,
		startedAt: new Date(state.startedAt).toISOString(),
		endedAt: state.endedAt ? new Date(state.endedAt).toISOString() : null,
		phase: state.phase,
		steps: state.steps.map((s) => ({
			id: s.id,
			label: s.label,
			status: s.status,
			message: s.message,
			evidence: s.evidence,
			durationMs:
				s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null,
		})),
	};
	downloadString(
		`pdscheck-${slug}-${state.startedAt}-oauth-flow.json`,
		JSON.stringify(payload, null, 2),
		"application/json",
	);
}

function FlowStepRow(props: { step: FlowStep }) {
	const [open, setOpen] = createSignal(false);
	const toggle = (event: MouseEvent) => {
		if (
			window.getSelection &&
			(window.getSelection()?.toString().length ?? 0) > 0
		)
			return;
		setOpen(!open());
		event.preventDefault();
	};

	const rowAccent = () => {
		switch (props.step.status) {
			case "fail":
				return "border-l-4 border-l-fail bg-fail/5";
			case "warn":
				return "border-l-4 border-l-warn bg-warn/5";
			default:
				return "border-l-4 border-l-transparent";
		}
	};
	const messageTone = () => {
		switch (props.step.status) {
			case "fail":
				return "text-fail font-medium";
			case "warn":
				return "text-warn font-medium";
			default:
				return "text-muted";
		}
	};
	const labelTone = () =>
		props.step.status === "fail" || props.step.status === "warn"
			? "font-bold"
			: "";

	return (
		<li class={`border-b border-line/60 last:border-0 ${rowAccent()}`}>
			<div
				role="button"
				tabindex={0}
				class="w-full grid grid-cols-[1.5rem_1fr_auto_auto_1rem] items-baseline gap-3 py-2 text-left text-sm hover:bg-line/30 px-2 cursor-text select-text"
				onMouseUp={toggle}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(!open());
					}
				}}
				aria-expanded={open()}
			>
				<span class="text-center select-none" aria-hidden>
					<StatusGlyph status={props.step.status} />
				</span>
				<span class="truncate min-w-0">
					<span class={labelTone()}>{props.step.label}</span>
					<Show when={props.step.message}>
						{(message) => (
							<span class={`${messageTone()} ml-2`}>— {message()}</span>
						)}
					</Show>
				</span>
				<span class="text-faint text-xs tabular-nums select-none" aria-hidden>
					{durationOf(props.step)}
				</span>
				<span class="text-xs select-none">
					<Show when={specUrlFor(props.step.id)}>
						{(url) => (
							<a
								href={url()}
								target="_blank"
								rel="noopener noreferrer"
								class="text-faint hover:text-ink underline decoration-dotted underline-offset-4"
								onClick={(e) => e.stopPropagation()}
								onMouseUp={(e) => e.stopPropagation()}
								title="View spec / RFC"
							>
								spec ↗
							</a>
						)}
					</Show>
				</span>
				<span
					class={`text-faint text-xs select-none transition-transform ${open() ? "rotate-0" : "-rotate-90"}`}
					aria-hidden
				>
					▾
				</span>
			</div>
			<Show when={open()}>
				<div class="mx-2 mb-2 mt-1 px-3 py-2 bg-line/20 text-xs space-y-2">
					<div class="flex flex-wrap items-baseline gap-x-3">
						<span class="text-faint uppercase tracking-[0.15em]">step</span>
						<code class="select-all">{props.step.id}</code>
					</div>
					<Show when={props.step.message}>
						{(message) => (
							<div class="flex flex-wrap items-baseline gap-x-3">
								<span class="text-faint uppercase tracking-[0.15em]">
									message
								</span>
								<span class="break-words flex-1 min-w-0">{message()}</span>
							</div>
						)}
					</Show>
					<Show when={props.step.evidence}>
						{(evidence) => (
							<details open class="text-xs">
								<summary class="text-faint uppercase tracking-[0.15em] cursor-pointer">
									evidence
								</summary>
								<pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-all select-all">
									{JSON.stringify(evidence(), null, 2)}
								</pre>
							</details>
						)}
					</Show>
				</div>
			</Show>
		</li>
	);
}

export function OAuthFlowView(props: {
	state: FlowState;
	onExit: () => void;
	onRedirect?: () => void;
	onReadChecks?: () => void;
	onWriteTests?: () => void;
}) {
	const summary = createMemo(() => {
		let pass = 0;
		let fail = 0;
		let applicable = 0;
		let done = 0;
		for (const step of props.state.steps) {
			if (step.status !== "pending" && step.status !== "running") done++;
			if (step.status === "pass") {
				pass++;
				applicable++;
			}
			if (
				step.status === "fail" ||
				step.status === "warn"
			) {
				applicable++;
			}
			if (step.status === "fail") fail++;
		}
		return { pass, fail, applicable, done, total: props.state.steps.length };
	});

	const phaseLabel = () =>
		({
			idle: "idle",
			"pre-redirect": "preparing authorization request",
			"ready-to-redirect": "ready to redirect — review and continue",
			redirecting: "redirecting to authorization endpoint…",
			"post-callback": "exchanging code and exercising token",
			done: "complete",
		})[props.state.phase];

	return (
		<div class="min-h-dvh flex flex-col">
			<header class="px-6 py-4 flex items-center justify-between text-sm border-b border-line">
				<a href="/" class="flex items-center gap-2">
					<span aria-hidden>☁️</span>
					<span class="font-bold tracking-[0.2em]">CHECK</span>
				</a>
				<a
					href="https://github.com/ascorbic/cirrus"
					class="text-faint hover:text-ink"
				>
					ascorbic/cirrus
				</a>
			</header>

			<section class="px-6 py-6 border-b border-line">
				<div class="max-w-3xl mx-auto">
					<div class="text-xs uppercase tracking-[0.2em] text-muted">
						OAuth conformance flow
					</div>
					<div class="flex items-baseline justify-between gap-3 mt-1">
						<h1 class="text-lg font-bold break-all">
							{props.state.target}
						</h1>
						<Show when={props.state.phase !== "done"}>
							<button
								type="button"
								onClick={props.onExit}
								class="text-xs text-faint hover:text-fail underline decoration-dotted underline-offset-4 select-none"
							>
								cancel flow ×
							</button>
						</Show>
					</div>
					<div class="mt-3 text-xs text-muted tabular-nums flex justify-between">
						<span>
							{summary().pass} / {summary().applicable} steps passing
							<Show when={summary().fail > 0}>
								<span class="text-fail ml-3">
									{summary().fail} failing
								</span>
							</Show>
						</span>
						<span aria-live="polite">{phaseLabel()}</span>
					</div>
					<Show when={props.state.phase === "done"}>
						<div class="mt-4 flex flex-wrap items-center gap-2 text-xs">
							<button
								type="button"
								onClick={() => downloadFlowFindings(props.state)}
								class="border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
								title="Markdown of OAuth flow findings + evidence, formatted to hand to an agent"
							>
								findings.md →
							</button>
							<button
								type="button"
								onClick={() => downloadFlowJson(props.state)}
								class="border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
							>
								download JSON
							</button>
						</div>
						<div class="mt-6 pt-4 border-t border-line">
							<div class="text-xs uppercase tracking-[0.2em] text-muted mb-3">
								what next
							</div>
							<div class="flex flex-col gap-2 text-sm">
								<button
									type="button"
									onClick={props.onExit}
									class="border border-ink px-4 py-2 text-left hover:bg-ink hover:text-paper transition-colors flex justify-between items-baseline gap-3"
								>
									<span class="font-bold tracking-wider">
										← VERIFY A DIFFERENT ACCOUNT
									</span>
									<span class="text-xs text-muted">back to landing</span>
								</button>
								<Show when={props.onReadChecks}>
									<button
										type="button"
										onClick={props.onReadChecks}
										class="border border-ink px-4 py-2 text-left hover:bg-ink hover:text-paper transition-colors flex justify-between items-baseline gap-3"
									>
										<span class="font-bold tracking-wider">
											READ-ONLY CHECKS →
										</span>
										<span class="text-xs text-muted">
											anonymous read checks against the same target
										</span>
									</button>
								</Show>
								<Show when={props.onWriteTests}>
									<button
										type="button"
										onClick={props.onWriteTests}
										class="border border-ink px-4 py-2 text-left hover:bg-ink hover:text-paper transition-colors flex justify-between items-baseline gap-3"
									>
										<span class="font-bold tracking-wider">
											TEST WRITE OPERATIONS →
										</span>
										<span class="text-xs text-muted">
											sign in + run write checks against the same target
										</span>
									</button>
								</Show>
							</div>
						</div>
					</Show>
				</div>
			</section>

			<Show when={props.state.phase === "ready-to-redirect"}>
				<section class="px-6 py-4 border-b border-line bg-ink text-paper">
					<div class="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-4">
						<div>
							<div class="text-xs uppercase tracking-[0.2em] opacity-70">
								Pre-redirect checks passed
							</div>
							<p class="mt-1 text-sm">
								Continue to{" "}
								<code class="bg-paper/20 px-1 py-0.5 truncate inline-block max-w-[40ch] align-bottom">
									{new URL(props.state.authUrl ?? "about:blank").host}
								</code>{" "}
								to authorize. The remaining checks run when you come back.
							</p>
						</div>
						<button
							type="button"
							onClick={props.onRedirect}
							class="border-2 border-paper bg-paper text-ink px-4 py-2 font-bold tracking-[0.15em] hover:bg-transparent hover:text-paper transition-colors"
						>
							CONTINUE →
						</button>
					</div>
				</section>
			</Show>

			<main class="flex-1 px-6 py-6">
				<div class="max-w-3xl mx-auto">
					<ul class="border border-line">
						<For each={props.state.steps}>
							{(step) => <FlowStepRow step={step} />}
						</For>
					</ul>
				</div>
			</main>
		</div>
	);
}
