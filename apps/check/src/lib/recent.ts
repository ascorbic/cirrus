import { createSignal } from "solid-js";
import type { Run } from "../types";

export interface RecentRun {
	target: string;
	completedAt: number;
	pass: number;
	fail: number;
	total: number;
}

const STORAGE_KEY = "pdscheck.recent-runs";
const MAX_ENTRIES = 8;

function read(): RecentRun[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as RecentRun[]) : [];
	} catch {
		return [];
	}
}

function write(runs: RecentRun[]): void {
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(runs.slice(0, MAX_ENTRIES)),
		);
	} catch {
		// localStorage disabled or full
	}
}

const [runs, setRuns] = createSignal<RecentRun[]>(read());

export const recentRuns = runs;

export function recordRun(run: Run): void {
	if (!run.endedAt) return;
	let pass = 0;
	let fail = 0;
	let applicable = 0;
	for (const result of run.results) {
		if (result.status === "pass") {
			pass++;
			applicable++;
		} else if (
			result.status === "fail" ||
			result.status === "error" ||
			result.status === "warn"
		) {
			applicable++;
		}
		if (result.status === "fail" || result.status === "error") fail++;
	}
	const entry: RecentRun = {
		target: run.target,
		completedAt: run.endedAt,
		pass,
		fail,
		total: applicable,
	};
	const next = [entry, ...runs().filter((r) => r.target !== entry.target)].slice(
		0,
		MAX_ENTRIES,
	);
	setRuns(next);
	write(next);
}
