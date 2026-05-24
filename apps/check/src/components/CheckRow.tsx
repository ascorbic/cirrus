import { Show, createSignal } from "solid-js";
import { specUrlFor } from "../lib/spec-urls";
import type { CheckResult } from "../types";
import { StatusGlyph } from "./StatusGlyph";

function formatDuration(result: CheckResult): string {
	if (!result.startedAt || !result.endedAt) return "";
	const ms = result.endedAt - result.startedAt;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function CheckRow(props: { result: CheckResult }) {
	const [open, setOpen] = createSignal(false);

	const toggle = (event: MouseEvent) => {
		// Allow text-selection drags inside the row to NOT toggle expansion.
		if (
			window.getSelection &&
			(window.getSelection()?.toString().length ?? 0) > 0
		)
			return;
		setOpen(!open());
		event.preventDefault();
	};

	const rowAccent = () => {
		switch (props.result.status) {
			case "fail":
			case "error":
				return "border-l-4 border-l-fail bg-fail/5";
			case "warn":
				return "border-l-4 border-l-warn bg-warn/5";
			default:
				return "border-l-4 border-l-transparent";
		}
	};
	const messageTone = () => {
		switch (props.result.status) {
			case "fail":
			case "error":
				return "text-fail font-medium";
			case "warn":
				return "text-warn font-medium";
			default:
				return "text-muted";
		}
	};
	const labelTone = () => {
		switch (props.result.status) {
			case "fail":
			case "error":
			case "warn":
				return "font-bold";
			default:
				return "";
		}
	};

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
					<StatusGlyph status={props.result.status} />
				</span>
				<span class="truncate min-w-0">
					<span class={labelTone()}>{props.result.check.label}</span>
					<Show when={props.result.outcome?.message}>
						{(message) => (
							<span class={`${messageTone()} ml-2`}>— {message()}</span>
						)}
					</Show>
				</span>
				<span class="text-faint text-xs tabular-nums select-none" aria-hidden>
					{formatDuration(props.result)}
				</span>
				<span class="text-xs select-none">
					<Show when={specUrlFor(props.result.check.id)}>
						{(url) => (
							<a
								href={url()}
								target="_blank"
								rel="noopener noreferrer"
								class="text-faint hover:text-ink underline decoration-dotted underline-offset-4"
								onClick={(e) => e.stopPropagation()}
								onMouseUp={(e) => e.stopPropagation()}
								title="View spec / lexicon"
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
						<span class="text-faint uppercase tracking-[0.15em]">
							check
						</span>
						<code class="select-all">{props.result.check.id}</code>
					</div>
					<Show when={props.result.outcome?.message}>
						{(message) => (
							<div class="flex flex-wrap items-baseline gap-x-3">
								<span class="text-faint uppercase tracking-[0.15em]">
									message
								</span>
								<span class="break-words flex-1 min-w-0">
									{message()}
								</span>
							</div>
						)}
					</Show>
					<Show when={props.result.outcome?.evidence}>
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
