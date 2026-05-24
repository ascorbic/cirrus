import { createStore, produce } from "solid-js/store";
import type {
	Check,
	CheckContext,
	CheckResult,
	CheckStatus,
	Run,
} from "./types";

export interface RunStore extends Run {
	results: readonly CheckResult[];
}

export function startRun(
	target: string,
	checks: readonly Check[],
	initial?: Partial<CheckContext>,
): RunStore {
	const [store, setStore] = createStore<{
		target: string;
		startedAt: number;
		endedAt?: number;
		results: CheckResult[];
	}>({
		target,
		startedAt: Date.now(),
		results: checks.map((check) => ({ check, status: "pending" })),
	});

	let aborted = false;
	const ctx: CheckContext = { target, signedIn: false, ...initial };

	const setResult = (i: number, patch: Partial<CheckResult>) =>
		setStore(
			"results",
			i,
			produce((result) => Object.assign(result, patch)),
		);

	void (async () => {
		for (let i = 0; i < checks.length; i++) {
			if (aborted) return;
			const check = checks[i]!;

			if (!hasRequirements(check, ctx)) {
				setResult(i, { status: "skip", startedAt: Date.now(), endedAt: Date.now() });
				continue;
			}

			setResult(i, { status: "running", startedAt: Date.now() });
			try {
				const outcome = await check.run(ctx);
				if (outcome.context) Object.assign(ctx, outcome.context);
				setResult(i, {
					status: outcomeToStatus(outcome.status),
					outcome,
					endedAt: Date.now(),
				});
			} catch (error) {
				setResult(i, {
					status: "error",
					outcome: {
						status: "fail",
						message: error instanceof Error ? error.message : String(error),
						evidence: { error: String(error) },
					},
					endedAt: Date.now(),
				});
			}
		}
		setStore("endedAt", Date.now());
	})();

	return {
		get target() {
			return store.target;
		},
		get startedAt() {
			return store.startedAt;
		},
		get endedAt() {
			return store.endedAt;
		},
		get results() {
			return store.results;
		},
		cancel() {
			aborted = true;
		},
	} satisfies Run;
}

function outcomeToStatus(s: "pass" | "fail" | "warn" | "skip"): CheckStatus {
	return s;
}

function hasRequirements(check: Check, ctx: CheckContext): boolean {
	if (!check.requires) return true;
	for (const req of check.requires) {
		if (req === "did" && !ctx.did) return false;
		if (req === "pds" && !ctx.pds) return false;
		if (req === "session" && !ctx.signedIn) return false;
	}
	return true;
}
