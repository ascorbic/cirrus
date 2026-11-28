#!/usr/bin/env node
/**
 * upgrade-pds - Upgrade a Cirrus PDS project and write its upgrade work order
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";

import packageJson from "../package.json" with { type: "json" };
import { validateOptions } from "./args.js";
import { renderUpgradeGuide } from "./guide.js";
import { createUpgradePlan } from "./plan.js";
import { loadProject, writeDependenciesAndInstall } from "./project.js";
import type { UpgradePlan } from "./types.js";

function printPlan(plan: UpgradePlan): void {
	p.note(
		[
			`${pc.dim("Project")}         ${plan.projectRoot}`,
			`${pc.dim("npm tag")}         ${plan.tag}`,
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
	p.log.step("Updating dependencies");
	await writeDependenciesAndInstall(project, plan.dependencies, () =>
		verifyInstalled(plan),
	);
	await mkdir(dirname(plan.guidePath), { recursive: true });
	await writeFile(plan.guidePath, renderUpgradeGuide(plan));
}

async function upgrade(args: {
	cwd: string;
	to: string;
	"dry-run": boolean;
	json: boolean;
	yes: boolean;
}): Promise<void> {
	validateOptions({ tag: args.to, json: args.json, yes: args.yes });
	const project = await loadProject(args.cwd);
	const plan = await createUpgradePlan(project, args.to);
	if (args.json) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}

	p.intro(pc.bgCyan(pc.black(" upgrade-pds ")));
	printPlan(plan);
	if (plan.dependencies.length === 0) {
		p.outro(
			`The Cirrus packages are already on the ${plan.tag} release. No files were changed.`,
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
			message: "Update these packages and install them?",
			initialValue: true,
		});
		if (p.isCancel(answer) || !answer) {
			p.cancel("Upgrade cancelled.");
			return;
		}
	}

	await applyPlan(plan);
	p.outro(
		`Packages updated. Give an agent this work order: ${pc.cyan(plan.guidePath)}`,
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
			p.log.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	},
});

runMain(main);
