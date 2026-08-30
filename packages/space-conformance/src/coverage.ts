/**
 * Coverage is computed, not remembered.
 *
 * The vendored lexicons define what a conforming implementation exposes:
 * every method, and every error it declares. Each of those wants at least
 * one `must` check citing it. When the weekly sync re-vendors a changed
 * lexicon, new methods and error names surface here as gaps the moment
 * they land — no human has to notice that an endpoint grew.
 */

import type { Check } from "./model.js";
import { lexicons, type LexiconDoc } from "./lexicons.js";

export interface CoverageRequirement {
	/** `<nsid>` for the method itself, `<nsid>@error:<Name>` for an error. */
	ref: string;
	kind: "method" | "error";
}

export interface CoverageReport {
	requirements: CoverageRequirement[];
	covered: Array<{ ref: string; by: string[] }>;
	gaps: CoverageRequirement[];
	/** Lexicon citations on checks that match no requirement (typo guard). */
	danglingCitations: Array<{ checkId: string; ref: string }>;
}

/** Extract the coverage requirements from the vendored lexicons. */
export function coverageRequirements(
	docs: LexiconDoc[] = lexicons,
): CoverageRequirement[] {
	const requirements: CoverageRequirement[] = [];
	for (const doc of docs) {
		const main = doc.defs.main as
			| { type?: string; errors?: Array<{ name: string }> }
			| undefined;
		if (!main || (main.type !== "query" && main.type !== "procedure")) {
			continue;
		}
		requirements.push({ ref: doc.id, kind: "method" });
		for (const error of main.errors ?? []) {
			requirements.push({
				ref: `${doc.id}@error:${error.name}`,
				kind: "error",
			});
		}
	}
	return requirements;
}

/**
 * A citation covers a requirement when it names the method (which covers
 * the method requirement) or the exact `@error:` form. A citation with a
 * `#def` fragment covers its method.
 */
function citationRefs(check: Check): string[] {
	return check.citations
		.filter((c) => c.source === "lexicon")
		.map((c) => c.ref);
}

export function coverageReport(
	catalog: Check[],
	docs: LexiconDoc[] = lexicons,
): CoverageReport {
	const requirements = coverageRequirements(docs);
	const known = new Set(requirements.map((r) => r.ref));
	const methodIds = new Set(
		requirements.filter((r) => r.kind === "method").map((r) => r.ref),
	);
	// Every vendored lexicon id, so a citation to a non-method document
	// (e.g. `com.atproto.space.defs`, the signed-commit shape) is
	// recognised as real rather than flagged as a typo.
	const knownDocIds = new Set(docs.map((d) => d.id));

	const coveredBy = new Map<string, string[]>();
	const dangling: CoverageReport["danglingCitations"] = [];
	const credit = (ref: string, checkId: string) =>
		coveredBy.set(ref, [...(coveredBy.get(ref) ?? []), checkId]);

	for (const check of catalog) {
		if (check.tier !== "must") continue;
		for (const ref of citationRefs(check)) {
			const methodRef = ref.split("@")[0]!.split("#")[0]!;

			// An `@error:` citation covers ONLY the exact error requirement.
			// It must never fall back to crediting the method: doing so would
			// silently absorb an error-name typo (or an upstream rename) and
			// falsely mark the method covered — defeating the typo guard this
			// report exists to provide.
			if (ref.includes("@error:")) {
				if (known.has(ref)) {
					credit(ref, check.id);
				} else {
					dangling.push({ checkId: check.id, ref });
				}
				continue;
			}

			// A method (or `#def`) citation.
			if (methodIds.has(methodRef)) {
				credit(methodRef, check.id);
			} else if (!knownDocIds.has(methodRef)) {
				// Names no vendored document at all — a typo.
				dangling.push({ checkId: check.id, ref });
			}
			// else: a `#def` reference to a real non-method document (e.g.
			// defs) — valid, contributes no method coverage, not dangling.
		}
	}

	const gaps = requirements.filter((r) => !coveredBy.has(r.ref));
	return {
		requirements,
		covered: Array.from(coveredBy, ([ref, by]) => ({ ref, by })),
		gaps,
		danglingCitations: dangling,
	};
}
