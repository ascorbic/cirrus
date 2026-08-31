/**
 * The check registry: catalog definition, validation and filtering.
 */

import type { Capability, Check, Tier } from "./model.js";

/**
 * Define a check, enforcing the catalog's structural rules at
 * registration time rather than in review:
 *
 * - ids are `area.slug`, unique within a catalog;
 * - a `must` check carries at least one citation to specified behavior —
 *   without one it is someone's opinion and belongs in `should` or `info`.
 */
export function defineCheck(check: Check): Check {
	if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(check.id)) {
		throw new Error(
			`Check id must be "area.slug" (kebab-case): ${check.id}`,
		);
	}
	if (check.tier === "must" && check.citations.length === 0) {
		throw new Error(
			`Check ${check.id} is tier "must" but cites nothing. Cite the lexicon, proposal or design spec — or demote it.`,
		);
	}
	return check;
}

export interface CatalogFilter {
	tiers?: Tier[];
	/** Capabilities the harness can provide. */
	capabilities?: Capability[];
	/** Include checks that create/delete state on the target. */
	destructive?: boolean;
	/** Include checks that wait out real expiry windows. */
	slow?: boolean;
	/** Restrict to areas (the part of the id before the dot). */
	areas?: string[];
	ids?: string[];
}

export interface FilteredCatalog {
	runnable: Check[];
	/** Checks excluded with the reason, for honest reporting. */
	skipped: Array<{ check: Check; reason: string }>;
}

export function buildCatalog(checks: Check[]): Check[] {
	const seen = new Set<string>();
	for (const check of checks) {
		if (seen.has(check.id)) {
			throw new Error(`Duplicate check id: ${check.id}`);
		}
		seen.add(check.id);
	}
	return checks;
}

/**
 * Partition a catalog into runnable and skipped for a given harness. A
 * skipped check is part of the report — "not testable here" must never
 * silently read as "conformant".
 */
export function filterCatalog(
	catalog: Check[],
	filter: CatalogFilter,
): FilteredCatalog {
	const capabilities = new Set(filter.capabilities ?? []);
	const runnable: Check[] = [];
	const skipped: FilteredCatalog["skipped"] = [];

	// Treat empty scoping arrays as "unset". An empty ids/areas/tiers list
	// otherwise matches nothing and yields a run of zero checks that reads
	// as clean — the exact silent-pass this suite must never produce.
	const ids = filter.ids?.length ? filter.ids : undefined;
	const areas = filter.areas?.length ? filter.areas : undefined;
	const tiers = filter.tiers?.length ? filter.tiers : undefined;

	for (const check of catalog) {
		if (ids && !ids.includes(check.id)) continue;
		const area = check.id.split(".")[0]!;
		if (areas && !areas.includes(area)) continue;
		if (tiers && !tiers.includes(check.tier)) {
			skipped.push({ check, reason: `tier ${check.tier} excluded` });
			continue;
		}
		if (check.destructive && !filter.destructive) {
			skipped.push({ check, reason: "destructive checks not enabled" });
			continue;
		}
		if (check.slow && !filter.slow) {
			skipped.push({ check, reason: "slow checks not enabled" });
			continue;
		}
		const missing = check.needs.filter((need) => !capabilities.has(need));
		if (missing.length > 0) {
			skipped.push({
				check,
				reason: `missing capabilities: ${missing.join(", ")}`,
			});
			continue;
		}
		runnable.push(check);
	}
	return { runnable, skipped };
}
