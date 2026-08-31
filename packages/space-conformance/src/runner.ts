/**
 * The core runner: executes a filtered catalog against one target and
 * produces a report. Transport- and environment-agnostic — the vitest
 * adapter, the CLI and the web checker all call this.
 */

import type { Check, CheckContext, CheckResult, Target } from "./model.js";
import type { FilteredCatalog } from "./registry.js";

export interface RunReport {
	suite: { name: string; version: string };
	/** The alpha build the suite's verifiers are pinned to. */
	alphaBuild: string;
	target: Target;
	startedAt: string;
	finishedAt: string;
	results: CheckResult[];
	logs: string[];
	summary: {
		pass: number;
		fail: number;
		mustFail: number;
		/**
		 * must-tier checks that errored (threw or timed out). A CI gate must
		 * treat these as failures too: an unreachable or hung target errors
		 * its checks rather than failing them, and must not exit 0.
		 */
		mustError: number;
		skipped: number;
		error: number;
	};
}

export interface RunOptions {
	catalog: FilteredCatalog;
	context: Omit<CheckContext, "state" | "log">;
	suiteVersion: string;
	alphaBuild: string;
	/** Per-check timeout; a hung target must not hang the run. */
	checkTimeoutMs?: number;
	/**
	 * Called with each result as it is determined, in run order — so a UI
	 * can render progress live instead of waiting for the whole report.
	 * Skipped results are delivered too (at the end). A throwing callback
	 * is contained: it must not be able to abort the run.
	 */
	onResult?: (result: CheckResult) => void;
}

export async function runChecks(options: RunOptions): Promise<RunReport> {
	const logs: string[] = [];
	const state = new Map<string, unknown>();
	const ctx: CheckContext = {
		...options.context,
		state,
		log: (message) => logs.push(message),
	};
	const timeoutMs = options.checkTimeoutMs ?? 30_000;
	const startedAt = new Date().toISOString();
	const results: CheckResult[] = [];
	const emit = (result: CheckResult) => {
		results.push(result);
		try {
			options.onResult?.(result);
		} catch {
			// The callback is an observer; its bugs must not abort the run.
		}
	};

	// Sequential on purpose: checks share probe state, and hammering a
	// live target in parallel makes failures racy and reports unreadable.
	for (const check of options.catalog.runnable) {
		const began = Date.now();
		// A per-check abort so a timed-out check's in-flight requests are
		// cancelled rather than continuing to fetch and mutate shared state
		// alongside the next check (the sequential invariant above).
		const controller = new AbortController();
		const checkCtx: CheckContext = {
			...ctx,
			fetch: (input, init) =>
				ctx.fetch(input, {
					...init,
					signal: init?.signal ?? controller.signal,
				}),
		};
		try {
			const outcome = await withTimeout(
				check.run(checkCtx),
				timeoutMs,
				check.id,
				controller,
			);
			emit({
				id: check.id,
				tier: check.tier,
				status: outcome.status,
				detail: outcome.detail,
				citations: check.citations,
				...(outcome.evidence !== undefined
					? { evidence: outcome.evidence }
					: {}),
				durationMs: Date.now() - began,
			});
		} catch (err) {
			// A thrown error means the CHECK broke (or the target hung) —
			// reported distinctly from a failing target so suite bugs don't
			// masquerade as non-conformance.
			emit({
				id: check.id,
				tier: check.tier,
				status: "error",
				detail: err instanceof Error ? err.message : String(err),
				citations: check.citations,
				durationMs: Date.now() - began,
			});
		}
	}

	for (const { check, reason } of options.catalog.skipped) {
		emit({
			id: check.id,
			tier: check.tier,
			status: "skipped",
			detail: reason,
			citations: check.citations,
		});
	}

	const summary = {
		pass: results.filter((r) => r.status === "pass").length,
		fail: results.filter((r) => r.status === "fail").length,
		mustFail: results.filter((r) => r.status === "fail" && r.tier === "must")
			.length,
		mustError: results.filter((r) => r.status === "error" && r.tier === "must")
			.length,
		skipped: results.filter((r) => r.status === "skipped").length,
		error: results.filter((r) => r.status === "error").length,
	};

	return {
		suite: {
			name: "@getcirrus/space-conformance",
			version: options.suiteVersion,
		},
		alphaBuild: options.alphaBuild,
		target: options.context.target,
		startedAt,
		finishedAt: new Date().toISOString(),
		results,
		logs,
		summary,
	};
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	id: string,
	controller: AbortController,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			// Abort the check's in-flight requests so it stops touching shared
			// state before the next check begins.
			controller.abort();
			reject(new Error(`check ${id} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Render a compact human-readable summary of a report. */
export function renderReport(report: RunReport): string {
	const lines: string[] = [];
	const icon = { pass: "✓", fail: "✗", skipped: "-", error: "!" } as const;
	lines.push(
		`# ${report.suite.name}@${report.suite.version} vs ${report.target.implementation ?? report.target.origin}`,
	);
	lines.push(`alpha build: ${report.alphaBuild}`);
	for (const result of report.results) {
		lines.push(
			`${icon[result.status]} [${result.tier}] ${result.id} — ${result.detail}`,
		);
	}
	const s = report.summary;
	lines.push(
		`${s.pass} pass, ${s.fail} fail (${s.mustFail} must), ${s.skipped} skipped, ${s.error} errored`,
	);
	return lines.join("\n");
}
