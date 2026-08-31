import { describe, expect, it } from "vitest";
import {
	buildCatalog,
	coverageReport,
	coverageRequirements,
	defineCheck,
	filterCatalog,
	lexicons,
	pass,
	fail,
	runChecks,
} from "../src/index";
import type { Check, Target } from "../src/index";

const TARGET: Target = {
	origin: "https://target.test",
	did: "did:web:target.test",
	implementation: "fake",
};

const okCheck = (id: string, overrides: Partial<Check> = {}): Check =>
	defineCheck({
		id,
		title: id,
		tier: "must",
		citations: [{ source: "lexicon", ref: "com.atproto.space.getRecord" }],
		needs: [],
		run: async () => pass("ok"),
		...overrides,
	});

describe("registry", () => {
	it("rejects malformed ids and uncited must checks", () => {
		expect(() => okCheck("NoDots")).toThrow(/area\.slug/);
		expect(() =>
			defineCheck({
				id: "auth.opinion",
				title: "x",
				tier: "must",
				citations: [],
				needs: [],
				run: async () => pass("ok"),
			}),
		).toThrow(/cites nothing/);
		// should/info may be uncited
		expect(() =>
			defineCheck({
				id: "auth.opinion",
				title: "x",
				tier: "info",
				citations: [],
				needs: [],
				run: async () => pass("ok"),
			}),
		).not.toThrow();
	});

	it("rejects duplicate ids", () => {
		expect(() => buildCatalog([okCheck("a.one"), okCheck("a.one")])).toThrow(
			/Duplicate/,
		);
	});

	it("filters by capability, destructive and slow — and reports skips", () => {
		const catalog = buildCatalog([
			okCheck("a.plain"),
			okCheck("a.needs-operator", { needs: ["operator"] }),
			okCheck("a.destructive", { destructive: true }),
			okCheck("a.slow", { slow: true }),
		]);
		const filtered = filterCatalog(catalog, { capabilities: [] });
		expect(filtered.runnable.map((c) => c.id)).toEqual(["a.plain"]);
		expect(filtered.skipped.map((s) => s.check.id).sort()).toEqual([
			"a.destructive",
			"a.needs-operator",
			"a.slow",
		]);
		const all = filterCatalog(catalog, {
			capabilities: ["operator"],
			destructive: true,
			slow: true,
		});
		expect(all.runnable).toHaveLength(4);
	});

	it("treats empty scoping arrays as unset, not match-nothing", () => {
		// A run of zero checks that reads as clean is the footgun this guards.
		const catalog = buildCatalog([okCheck("a.one"), okCheck("b.two")]);
		const empties = filterCatalog(catalog, {
			ids: [],
			areas: [],
			tiers: [],
			capabilities: [],
		});
		expect(empties.runnable.map((c) => c.id).sort()).toEqual([
			"a.one",
			"b.two",
		]);
	});
});

describe("runner", () => {
	it("runs checks, records outcomes, and reports skips honestly", async () => {
		const catalog = buildCatalog([
			okCheck("a.passes"),
			okCheck("a.fails", { run: async () => fail("nope") }),
			okCheck("a.throws", {
				run: async () => {
					throw new Error("check exploded");
				},
			}),
			okCheck("a.needs-inbox", { needs: ["syncer-inbox"] }),
		]);
		const report = await runChecks({
			catalog: filterCatalog(catalog, { capabilities: [] }),
			context: { target: TARGET, fetch },
			suiteVersion: "0.0.0-test",
			alphaBuild: "0.0.0-spaces-alpha-test",
		});
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
		expect(byId["a.passes"]!.status).toBe("pass");
		expect(byId["a.fails"]!.status).toBe("fail");
		expect(byId["a.throws"]!.status).toBe("error");
		expect(byId["a.needs-inbox"]!.status).toBe("skipped");
		expect(report.summary).toMatchObject({
			pass: 1,
			fail: 1,
			mustFail: 1,
			// The throwing check is must-tier, so it counts as a must error —
			// what a CI gate must treat as a failure (unreachable target).
			mustError: 1,
			error: 1,
			skipped: 1,
		});
	});

	it("streams each result to onResult as it lands, throwing observer contained", async () => {
		const catalog = buildCatalog([
			okCheck("a.first"),
			okCheck("a.second", { run: async () => fail("nope") }),
			okCheck("a.skips", { needs: ["syncer-inbox"] }),
		]);
		const seen: string[] = [];
		const report = await runChecks({
			catalog: filterCatalog(catalog, { capabilities: [] }),
			context: { target: TARGET, fetch },
			suiteVersion: "0.0.0-test",
			alphaBuild: "0.0.0-spaces-alpha-test",
			onResult: (result) => {
				seen.push(`${result.id}:${result.status}`);
				// An observer bug must not abort the run or drop results.
				throw new Error("observer exploded");
			},
		});
		expect(seen).toEqual(["a.first:pass", "a.second:fail", "a.skips:skipped"]);
		expect(report.results).toHaveLength(3);
	});

	it("aborts a timed-out check's in-flight requests", async () => {
		let aborted = false;
		const catalog = buildCatalog([
			okCheck("a.hangs-on-fetch", {
				run: (ctx) =>
					new Promise((_resolve, reject) => {
						// Simulate an in-flight request that observes the abort.
						void ctx.fetch("https://target.test/slow").catch((err) => {
							if ((err as Error).name === "AbortError") aborted = true;
							reject(err);
						});
					}),
			}),
		]);
		const report = await runChecks({
			catalog: filterCatalog(catalog, { capabilities: [] }),
			context: {
				target: TARGET,
				// A fetch that never resolves until aborted.
				fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise((_res, rej) => {
						init?.signal?.addEventListener("abort", () =>
							rej(new DOMException("aborted", "AbortError")),
						);
					})) as typeof fetch,
			},
			suiteVersion: "0.0.0-test",
			alphaBuild: "test",
			checkTimeoutMs: 40,
		});
		expect(report.results[0]!.status).toBe("error");
		expect(aborted).toBe(true);
	});

	it("shares state between checks and times out hung checks", async () => {
		const catalog = buildCatalog([
			okCheck("a.setup", {
				run: async (ctx) => {
					ctx.state.set("probe", "value");
					return pass("stored");
				},
			}),
			okCheck("a.reads-state", {
				run: async (ctx) =>
					ctx.state.get("probe") === "value"
						? pass("read")
						: fail("state missing"),
			}),
			okCheck("a.hangs", {
				run: () => new Promise(() => {}),
			}),
		]);
		const report = await runChecks({
			catalog: filterCatalog(catalog, { capabilities: [] }),
			context: { target: TARGET, fetch },
			suiteVersion: "0.0.0-test",
			alphaBuild: "test",
			checkTimeoutMs: 50,
		});
		const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
		expect(byId["a.reads-state"]!.status).toBe("pass");
		expect(byId["a.hangs"]!.status).toBe("error");
		expect(byId["a.hangs"]!.detail).toMatch(/timed out/);
	});
});

describe("coverage", () => {
	it("derives requirements from the vendored lexicons", () => {
		const requirements = coverageRequirements();
		const refs = requirements.map((r) => r.ref);
		// Methods
		expect(refs).toContain("com.atproto.space.getRecord");
		expect(refs).toContain("com.atproto.simplespace.createSpace");
		// Declared errors, exactly as named
		expect(refs).toContain(
			"com.atproto.space.getSpaceCredential@error:UserNotAuthorized",
		);
		expect(refs).toContain(
			"com.atproto.space.getSpaceCredential@error:SpaceDeleted",
		);
		expect(refs).toContain(
			"com.atproto.simplespace.createSpace@error:UnsupportedPolicy",
		);
		// defs.json is not a method and contributes nothing
		expect(refs.every((r) => !r.startsWith("com.atproto.space.defs"))).toBe(
			true,
		);
	});

	it("flags an @error typo as dangling instead of crediting the method", () => {
		// The whole point of the citation guard: an @error citation that
		// names a real method but a wrong error must NOT be silently credited
		// to the method (which would hide the typo and fake coverage).
		const catalog = buildCatalog([
			okCheck("record.typo-error", {
				citations: [
					{
						source: "lexicon",
						// getRecord is a real method; RecordMissing is not a real
						// declared error (the real one is RecordNotFound).
						ref: "com.atproto.space.getRecord@error:RecordMissing",
					},
				],
			}),
		]);
		const report = coverageReport(catalog);
		expect(report.danglingCitations).toEqual([
			{
				checkId: "record.typo-error",
				ref: "com.atproto.space.getRecord@error:RecordMissing",
			},
		]);
		// And the method is NOT falsely marked covered by that citation.
		expect(report.covered.map((c) => c.ref)).not.toContain(
			"com.atproto.space.getRecord",
		);
	});

	it("accepts a #def citation to a real non-method document", () => {
		const catalog = buildCatalog([
			okCheck("commit.shape", {
				citations: [
					{ source: "lexicon", ref: "com.atproto.space.defs#signedCommit" },
				],
			}),
		]);
		const report = coverageReport(catalog);
		// defs is a real vendored document, just not a method — valid, not dangling.
		expect(report.danglingCitations).toEqual([]);
	});

	it("reports gaps and dangling citations", () => {
		const catalog = buildCatalog([
			okCheck("record.get", {
				citations: [
					{ source: "lexicon", ref: "com.atproto.space.getRecord" },
					{
						source: "lexicon",
						ref: "com.atproto.space.getRecord@error:RecordNotFound",
					},
				],
			}),
			okCheck("record.typo", {
				citations: [{ source: "lexicon", ref: "com.atproto.space.getRekord" }],
			}),
		]);
		const report = coverageReport(catalog);
		const covered = report.covered.map((c) => c.ref);
		expect(covered).toContain("com.atproto.space.getRecord");
		expect(covered).toContain(
			"com.atproto.space.getRecord@error:RecordNotFound",
		);
		expect(report.danglingCitations).toEqual([
			{ checkId: "record.typo", ref: "com.atproto.space.getRekord" },
		]);
		// Everything not cited is a gap — e.g. listRepos is uncovered here.
		expect(report.gaps.map((g) => g.ref)).toContain(
			"com.atproto.space.listRepos",
		);
	});

	it("vendored lexicons parse and are all com.atproto space documents", () => {
		expect(lexicons.length).toBeGreaterThanOrEqual(29);
		for (const doc of lexicons) {
			expect(doc.lexicon).toBe(1);
			expect(doc.id).toMatch(/^com\.atproto\.(space|simplespace)\./);
		}
	});
});
