import { describe, expect, it } from "vitest";

import { agentNextSteps, agentUsage } from "../src/agent.js";
import type { UpgradePlan } from "../src/types.js";

const plan: UpgradePlan = {
	projectRoot: "/pds",
	packageManager: "pnpm",
	tag: "latest",
	dependencies: [
		{
			name: "@getcirrus/pds",
			section: "dependencies",
			from: "^0.18.0",
			to: "^0.19.0",
			fromVersion: "0.18.0",
			toVersion: "0.19.0",
		},
	],
	skipped: [],
	transitive: [],
	changelog: [],
	guidePath: "/pds/.cirrus/UPGRADE.md",
	commands: {
		install: "pnpm install",
		statusDev: "pnpm exec pds status --dev",
		status: "pnpm exec pds status",
	},
};

describe("agentUsage", () => {
	it("gives the command that applies the plan", () => {
		expect(agentUsage(plan)).toContain("npx upgrade-pds@latest --yes\n");
	});

	it("repeats the tag and from version in that command", () => {
		expect(agentUsage({ ...plan, tag: "next", from: "0.17.1" })).toContain(
			"npx upgrade-pds@latest --to next --from 0.17.1 --yes\n",
		);
	});

	it("says what applying changes and what it leaves alone", () => {
		const usage = agentUsage(plan);

		expect(usage).toContain("Nothing was changed.");
		expect(usage).toContain("pnpm install");
		expect(usage).toContain("/pds/.cirrus/UPGRADE.md");
		expect(usage).toContain("does not edit the wrangler config");
	});

	it("explains --from for a project that was already updated", () => {
		expect(agentUsage(plan)).toContain("--from <version>");
		expect(agentUsage({ ...plan, from: "0.17.1" })).not.toContain(
			"--from <version>",
		);
	});
});

describe("agentNextSteps", () => {
	it("tells the agent to read and follow the work order, and not to deploy unasked", () => {
		const steps = agentNextSteps(plan);

		expect(steps).toContain("Read /pds/.cirrus/UPGRADE.md");
		expect(steps).toContain("Do not deploy");
	});
});
