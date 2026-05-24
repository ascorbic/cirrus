import { For, Show, createMemo, createSignal } from "solid-js";
import { specUrlFor } from "../lib/spec-urls";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type CheckCategory,
	type CheckResult,
	type Run,
} from "../types";
import { CheckRow } from "./CheckRow";

function downloadString(filename: string, content: string, mime: string): void {
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

function generateFailuresMarkdown(run: Run): string {
	const failures = run.results.filter(
		(r) => r.status === "fail" || r.status === "error",
	);
	const warnings = run.results.filter((r) => r.status === "warn");
	const passed = run.results.filter((r) => r.status === "pass").length;
	const skipped = run.results.filter((r) => r.status === "skip").length;

	const lines: string[] = [];
	lines.push("# PDS conformance findings");
	lines.push("");
	lines.push(`**Target:** \`${run.target}\`  `);
	lines.push(`**Run started:** ${new Date(run.startedAt).toISOString()}  `);
	if (run.endedAt) {
		lines.push(`**Run ended:** ${new Date(run.endedAt).toISOString()}  `);
	}
	lines.push(`**Verifier:** ${location.origin}  `);
	lines.push("");
	lines.push(
		"> **For agents:** each finding below is a real failure observed against an AT Protocol PDS. " +
			"Use the evidence (request URL, response body, validation issues with field paths) to diagnose the cause, " +
			"consult the relevant spec at https://atproto.com/specs and the lexicon definitions in `@atcute/atproto`, " +
			"and re-run pdscheck against the target after fixing to confirm.",
	);
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push(`- **${failures.length}** failure${failures.length === 1 ? "" : "s"}`);
	if (warnings.length > 0) {
		lines.push(
			`- **${warnings.length}** warning${warnings.length === 1 ? "" : "s"}`,
		);
	}
	lines.push(`- ${passed} passed`);
	if (skipped > 0) lines.push(`- ${skipped} skipped`);
	lines.push(`- ${run.results.length} checks total`);
	lines.push("");

	if (failures.length === 0 && warnings.length === 0) {
		lines.push("No failures or warnings — every applicable check passed.");
		return lines.join("\n");
	}

	const renderFinding = (r: CheckResult) => {
		lines.push(`### ${r.check.label}`);
		lines.push("");
		lines.push(`- **Check ID:** \`${r.check.id}\``);
		lines.push(`- **Category:** ${r.check.category}`);
		lines.push(`- **Status:** ${r.status}`);
		const spec = specUrlFor(r.check.id);
		if (spec) lines.push(`- **Spec:** ${spec}`);
		if (r.outcome?.message) {
			lines.push(`- **Message:** ${r.outcome.message}`);
		}
		if (r.startedAt && r.endedAt) {
			lines.push(`- **Duration:** ${r.endedAt - r.startedAt}ms`);
		}
		lines.push("");

		const evidence = r.outcome?.evidence;
		if (evidence) {
			if (evidence.request) {
				lines.push(
					`**Request:** \`${evidence.request.method} ${evidence.request.url}\``,
				);
				lines.push("");
			}
			if (evidence.response) {
				lines.push("**Response:**");
				lines.push("");
				lines.push("```json");
				lines.push(JSON.stringify(evidence.response, null, 2));
				lines.push("```");
				lines.push("");
			}
			if (evidence.expected !== undefined || evidence.actual !== undefined) {
				lines.push("**Expected vs actual:**");
				lines.push("");
				lines.push("```json");
				lines.push(
					JSON.stringify(
						{ expected: evidence.expected, actual: evidence.actual },
						null,
						2,
					),
				);
				lines.push("```");
				lines.push("");
			}
			if (evidence.error) {
				lines.push("**Error / validation issues:**");
				lines.push("");
				lines.push("```");
				lines.push(evidence.error);
				lines.push("```");
				lines.push("");
			}
		}
	};

	if (failures.length > 0) {
		lines.push("## Failures");
		lines.push("");
		for (const r of failures) renderFinding(r);
	}

	if (warnings.length > 0) {
		lines.push("## Warnings");
		lines.push("");
		for (const r of warnings) renderFinding(r);
	}

	lines.push("---");
	lines.push("");
	lines.push(
		`To reproduce: ${location.origin}/?target=${encodeURIComponent(run.target)}`,
	);
	lines.push("");

	return lines.join("\n");
}

function downloadJson(run: Run): void {
	const payload = {
		target: run.target,
		startedAt: new Date(run.startedAt).toISOString(),
		endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
		results: run.results.map((r) => ({
			id: r.check.id,
			category: r.check.category,
			label: r.check.label,
			status: r.status,
			message: r.outcome?.message,
			evidence: r.outcome?.evidence,
			durationMs:
				r.startedAt && r.endedAt ? r.endedAt - r.startedAt : null,
		})),
	};
	const slug = run.target.replace(/[^a-z0-9.-]/gi, "_");
	downloadString(
		`pdscheck-${slug}-${run.startedAt}.json`,
		JSON.stringify(payload, null, 2),
		"application/json",
	);
}

function downloadFailuresMarkdown(run: Run): void {
	const slug = run.target.replace(/[^a-z0-9.-]/gi, "_");
	downloadString(
		`pdscheck-${slug}-${run.startedAt}-findings.md`,
		generateFailuresMarkdown(run),
		"text/markdown",
	);
}

function groupByCategory(
	results: readonly CheckResult[],
): Array<[CheckCategory, CheckResult[]]> {
	const map = new Map<CheckCategory, CheckResult[]>();
	for (const result of results) {
		const list = map.get(result.check.category) ?? [];
		list.push(result);
		map.set(result.check.category, list);
	}
	return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!]);
}

function summarize(results: readonly CheckResult[]) {
	let done = 0;
	let pass = 0;
	let fail = 0;
	let applicable = 0;
	for (const r of results) {
		if (r.status !== "pending" && r.status !== "running") done++;
		if (r.status === "pass") {
			pass++;
			applicable++;
		}
		if (
			r.status === "fail" ||
			r.status === "error" ||
			r.status === "warn"
		) {
			applicable++;
		}
		if (r.status === "fail" || r.status === "error") fail++;
	}
	return {
		done,
		pass,
		fail,
		applicable,
		total: results.length,
	};
}

export function RunView(props: {
	run: Run;
	mode: "verify" | "writes";
	onCancel: () => void;
	onReadChecks?: () => void;
	onWriteTests?: () => void;
	onOAuthConformance?: () => void;
}) {
	const groups = createMemo(() => groupByCategory(props.run.results));
	const summary = createMemo(() => summarize(props.run.results));
	const progress = createMemo(() =>
		summary().total === 0 ? 0 : (summary().done / summary().total) * 100,
	);
	const finished = createMemo(() => props.run.endedAt !== undefined);

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

			<Show
				when={finished()}
				fallback={
					<section class="px-6 py-6 border-b border-line">
						<div class="max-w-3xl mx-auto">
							<div class="flex items-baseline justify-between gap-3">
								<h1 class="text-lg font-bold break-all">
									{props.run.target}
								</h1>
								<button
									type="button"
									onClick={props.onCancel}
									class="text-xs text-faint hover:text-fail underline decoration-dotted underline-offset-4 select-none"
								>
									cancel run ×
								</button>
							</div>
							<div
								class="mt-3 h-1 bg-line overflow-hidden"
								role="progressbar"
								aria-valuenow={Math.round(progress())}
								aria-valuemin="0"
								aria-valuemax="100"
							>
								<div
									class="h-full bg-ink transition-[width] duration-300"
									style={{ width: `${progress()}%` }}
								/>
							</div>
							<div class="mt-2 text-xs text-muted tabular-nums flex justify-between">
								<span>
									{summary().done} / {summary().total} checks
									<Show when={summary().fail > 0}>
										<span class="text-fail ml-3">
											{summary().fail} failing
										</span>
									</Show>
								</span>
								<span aria-live="polite">running…</span>
							</div>
						</div>
					</section>
				}
			>
				<ResultSummary
					run={props.run}
					mode={props.mode}
					summary={summary()}
					total={summary().total}
					onCancel={props.onCancel}
					onReadChecks={props.onReadChecks}
					onWriteTests={props.onWriteTests}
					onOAuthConformance={props.onOAuthConformance}
				/>
			</Show>

			<main class="flex-1 px-6 py-6 pt-0">
				<div class="max-w-3xl mx-auto">
					<div
						aria-live="polite"
						aria-atomic="false"
						class="sr-only"
					>
						<For each={props.run.results}>
							{(result) => (
								<Show
									when={
										result.status === "fail" || result.status === "error"
									}
								>
									{result.check.label} failed
								</Show>
							)}
						</For>
					</div>

					<For each={groups()}>
						{([category, results]) => {
							const catSummary = createMemo(() => summarize(results));
							return (
								<section class="mb-6" aria-labelledby={`cat-${category}`}>
									<h2
										id={`cat-${category}`}
										class="flex items-baseline justify-between text-xs uppercase tracking-[0.2em] text-muted mb-2 px-2"
									>
										<span>{CATEGORY_LABELS[category]}</span>
										<span class="tabular-nums">
											<Show
												when={catSummary().applicable > 0}
												fallback={<span class="text-faint">skipped</span>}
											>
												{catSummary().pass} / {catSummary().applicable}
											</Show>
										</span>
									</h2>
									<ul class="border border-line">
										<For each={results}>
											{(result) => <CheckRow result={result} />}
										</For>
									</ul>
								</section>
							);
						}}
					</For>
				</div>
			</main>
		</div>
	);
}

function ResultSummary(props: {
	run: Run;
	mode: "verify" | "writes";
	summary: {
		done: number;
		pass: number;
		fail: number;
		applicable: number;
		total: number;
	};
	total: number;
	onCancel: () => void;
	onReadChecks?: () => void;
	onWriteTests?: () => void;
	onOAuthConformance?: () => void;
}) {
	const [copied, setCopied] = createSignal(false);
	const duration = () =>
		props.run.endedAt && props.run.startedAt
			? `${((props.run.endedAt - props.run.startedAt) / 1000).toFixed(1)}s`
			: "";
	const skipped = () => props.summary.total - props.summary.applicable;

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(location.href);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard blocked
		}
	}

	return (
		<section class="px-6 py-6 border-b border-line">
			<div class="max-w-3xl mx-auto">
				<div class="flex items-center justify-between gap-6 flex-wrap">
					<div class="flex-1 min-w-0">
						<div class="text-xs uppercase tracking-[0.2em] text-muted">
							Result
						</div>
						<h1 class="text-lg font-bold break-all mt-1">
							{props.run.target}
						</h1>
					</div>
					<div class="flex items-center gap-6 tabular-nums">
						<div class="text-right">
							<div class="text-xs uppercase tracking-[0.2em] text-muted">
								Score
							</div>
							<div
								class={`text-2xl ${
									props.summary.fail === 0 ? "text-pass" : "text-fail"
								}`}
							>
								{props.summary.pass} / {props.summary.applicable}
							</div>
							<Show when={skipped() > 0}>
								<div class="text-[10px] text-faint">
									{skipped()} skipped
								</div>
							</Show>
						</div>
					</div>
				</div>
				<div class="mt-4 flex flex-wrap items-center gap-2 text-xs">
					<button
						type="button"
						onClick={copyLink}
						class="border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
					>
						{copied() ? "copied ✓" : "copy share link"}
					</button>
					<button
						type="button"
						onClick={() => downloadJson(props.run)}
						class="border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
					>
						download JSON
					</button>
					<button
						type="button"
						onClick={() => downloadFailuresMarkdown(props.run)}
						class="border border-ink px-3 py-1 hover:bg-ink hover:text-paper transition-colors"
						title="Markdown of findings + evidence, formatted to hand to an agent"
					>
						findings.md →
					</button>
					<span class="text-faint ml-auto">finished in {duration()}</span>
				</div>

				<div class="mt-6 pt-4 border-t border-line">
					<div class="text-xs uppercase tracking-[0.2em] text-muted mb-3">
						what next
					</div>
					<div class="flex flex-col gap-2 text-sm">
						<button
							type="button"
							onClick={props.onCancel}
							class="border border-ink px-4 py-2 text-left hover:bg-ink hover:text-paper transition-colors flex justify-between items-baseline gap-3"
						>
							<span class="font-bold tracking-wider">
								← VERIFY A DIFFERENT ACCOUNT
							</span>
							<span class="text-xs text-muted">back to landing</span>
						</button>
						<Show when={props.onReadChecks && props.mode !== "verify"}>
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
						<Show when={props.onWriteTests && props.mode !== "writes"}>
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
						<Show when={props.onOAuthConformance}>
							<button
								type="button"
								onClick={props.onOAuthConformance}
								class="border border-ink px-4 py-2 text-left hover:bg-ink hover:text-paper transition-colors flex justify-between items-baseline gap-3"
							>
								<span class="font-bold tracking-wider">
									TEST OAUTH CONFORMANCE →
								</span>
								<span class="text-xs text-muted">
									full OAuth flow probe + boundary tests
								</span>
							</button>
						</Show>
					</div>
				</div>
			</div>
		</section>
	);
}
