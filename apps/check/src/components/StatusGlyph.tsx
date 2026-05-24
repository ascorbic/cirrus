import { Show } from "solid-js";
import type { CheckStatus } from "../types";

const GLYPHS: Record<Exclude<CheckStatus, "running">, string> = {
	pending: "◯",
	pass: "✓",
	fail: "✗",
	warn: "▲",
	skip: "⊘",
	error: "✗",
};

const LABELS: Record<CheckStatus, string> = {
	pending: "Pending",
	running: "Running",
	pass: "Pass",
	fail: "Fail",
	warn: "Warning",
	skip: "Skipped",
	error: "Error",
};

const COLOR: Record<Exclude<CheckStatus, "running">, string> = {
	pending: "text-faint",
	pass: "text-pass",
	fail: "text-fail",
	warn: "text-warn",
	skip: "text-faint",
	error: "text-fail",
};

export function StatusGlyph(props: { status: CheckStatus }) {
	return (
		<Show
			when={props.status === "running"}
			fallback={
				<span
					class={COLOR[props.status as Exclude<CheckStatus, "running">]}
					aria-label={LABELS[props.status]}
					role="status"
				>
					{GLYPHS[props.status as Exclude<CheckStatus, "running">]}
				</span>
			}
		>
			<span
				class="inline-block w-3 h-3 border-2 border-ink border-t-transparent rounded-full animate-spin align-middle"
				aria-label={LABELS.running}
				role="status"
			/>
		</Show>
	);
}
