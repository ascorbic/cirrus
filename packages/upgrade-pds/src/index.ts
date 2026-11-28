#!/usr/bin/env node
/**
 * upgrade-pds - Upgrade a Cirrus PDS project and write its upgrade work order
 */
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";

import packageJson from "../package.json" with { type: "json" };
import { validateOptions } from "./args.js";
import { writeUpgradeGuide } from "./guide.js";
import { createUpgradePlan } from "./plan.js";
import { loadProject, writeDependenciesAndInstall } from "./project.js";
import type { UpgradePlan } from "./types.js";

function printPlan(plan: UpgradePlan): void {
	p.note(
		[
			`${pc.dim("Project")}         ${plan.projectRoot}`,
			`${pc.dim("npm tag")}         ${plan.tag}`,
			...(plan.from
				? [`${pc.dim("From")}            @getcirrus/pds ${plan.from}`]
				: []),
			`${pc.dim("Release entries")} ${plan.changelog.length}`,
			`${pc.dim("Work order")}      ${plan.guidePath}`,
		].join("\n"),
		"Upgrade plan",
	);
	for (const change of plan.dependencies) {
		p.log.info(`${change.name}: ${change.fromVersion} → ${change.toVersion}`);
	}
	for (const change of plan.transitive) {
		p.log.info(
			`${change.name}: ${change.fromVersion ?? "not installed"} → ${change.toVersion} ${pc.dim("(through @getcirrus/pds)")}`,
		);
	}
	for (const dependency of plan.skipped) {
		p.log.warn(
			`${dependency.name} (${dependency.specifier}) will not be changed: ${dependency.reason}.`,
		);
	}
}

async function verifyInstalled(plan: UpgradePlan): Promise<void> {
	const installed = await loadProject(plan.projectRoot);
	for (const change of plan.dependencies) {
		const version = installed.dependencies.find(
			(dependency) =>
				dependency.name === change.name &&
				dependency.section === change.section,
		)?.installedVersion;
		if (version !== change.toVersion) {
			throw new Error(
				`${change.name} resolved to ${version ?? "nothing"}, but npm ${plan.tag} resolved to ${change.toVersion}.`,
			);
		}
	}
}

async function applyPlan(plan: UpgradePlan): Promise<void> {
	const project = await loadProject(plan.projectRoot);
	// Written before the install: once the packages have moved, the range this
	// work order covers can no longer be derived from the project.
	const guide = await writeUpgradeGuide(plan);
	if (plan.dependencies.length > 0) p.log.step("Updating dependencies");
	try {
		await writeDependenciesAndInstall(project, plan.dependencies, () =>
			verifyInstalled(plan),
		);
	} catch (error) {
		await guide.undo();
		throw error;
	}
}

async function upgrade(args: {
	cwd: string;
	to: string;
	"dry-run": boolean;
	json: boolean;
	yes: boolean;
	from?: string;
}): Promise<void> {
	validateOptions({
		tag: args.to,
		json: args.json,
		yes: args.yes,
		from: args.from,
	});
	const project = await loadProject(args.cwd);
	const plan = await createUpgradePlan(project, args.to, fetch, args.from);
	if (args.json) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}

	p.intro(pc.bgCyan(pc.black(" upgrade-pds ")));
	printPlan(plan);
	const installs = plan.dependencies.length > 0;
	if (!installs && (!plan.from || plan.changelog.length === 0)) {
		p.outro(
			plan.skipped.length > 0
				? "There is nothing for upgrade-pds to change. No files were changed."
				: `The Cirrus packages are already on the ${plan.tag} release. No files were changed.`,
		);
		return;
	}
	if (args["dry-run"]) {
		p.outro("Dry run complete. No files were changed.");
		return;
	}

	if (!args.yes) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			p.cancel(
				"Re-run with --yes to apply this plan in a non-interactive shell.",
			);
			process.exitCode = 1;
			return;
		}
		const answer = await p.confirm({
			message: installs
				? "Update these packages and install them?"
				: "Write the work order?",
			initialValue: true,
		});
		if (p.isCancel(answer) || !answer) {
			p.cancel("Upgrade cancelled.");
			return;
		}
	}

	await applyPlan(plan);
	p.outro(
		`${installs ? "Packages updated" : "Work order written"}. Give an agent this work order: ${pc.cyan(plan.guidePath)}`,
	);
}

const main = defineCommand({
	meta: {
		name: "upgrade-pds",
		version: packageJson.version,
		description:
			"Upgrade a Cirrus PDS project to an npm release tag and write its upgrade work order",
	},
	args: {
		cwd: {
			type: "string",
			description: "Project directory",
			default: ".",
		},
		to: {
			type: "string",
			description: "npm dist-tag to install",
			default: "latest",
		},
		from: {
			type: "string",
			description:
				"@getcirrus/pds version the project was on, to cover release entries from before the installed version",
		},
		"dry-run": {
			type: "boolean",
			description: "Show the upgrade plan without changing files",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Print the upgrade plan as JSON without changing files",
			default: false,
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Apply without an interactive confirmation",
			default: false,
		},
	},
	async run({ args }) {
		try {
			await upgrade(args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (args.json) process.stderr.write(`${message}\n`);
			else p.log.error(message);
			process.exitCode = 1;
		}
	},
});

runMain(main);
