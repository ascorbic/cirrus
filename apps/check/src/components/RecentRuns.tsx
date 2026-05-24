import { For, Show } from "solid-js";
import { recentRuns } from "../lib/recent";

export function RecentRuns(props: { onSelect: (target: string) => void }) {
	return (
		<Show when={recentRuns().length > 0}>
			<div class="mt-10 border-t border-line pt-6">
				<div class="text-xs uppercase tracking-[0.2em] text-muted mb-3">
					Recent
				</div>
				<ul>
					<For each={recentRuns()}>
						{(run) => {
							const ok = run.fail === 0;
							return (
								<li>
									<button
										type="button"
										onClick={() => props.onSelect(run.target)}
										class="w-full grid grid-cols-[1rem_1fr_auto] items-baseline gap-3 text-sm hover:bg-line/30 px-2 py-1 -mx-2 text-left"
									>
										<span class={ok ? "text-pass" : "text-fail"}>
											{ok ? "✓" : "✗"}
										</span>
										<span class="truncate">{run.target}</span>
										<span class="text-faint tabular-nums text-xs">
											{run.pass}/{run.total}
										</span>
									</button>
								</li>
							);
						}}
					</For>
				</ul>
			</div>
		</Show>
	);
}
