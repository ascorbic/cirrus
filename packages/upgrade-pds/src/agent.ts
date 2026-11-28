import type { UpgradePlan } from "./types.js";

function applyCommand(plan: UpgradePlan): string {
	return [
		"npx upgrade-pds@latest",
		...(plan.tag === "latest" ? [] : [`--to ${plan.tag}`]),
		...(plan.from ? [`--from ${plan.from}`] : []),
		"--yes",
	].join(" ");
}

/** Shown to a coding agent that ran the command without `--yes`. */
export function agentUsage(plan: UpgradePlan): string {
	const writes =
		plan.dependencies.length > 0
			? `It updates the Cirrus packages in package.json, runs \`${plan.commands.install}\`, and writes the work order to ${plan.guidePath}.`
			: `It writes the work order to ${plan.guidePath} and changes no package.`;
	const from = plan.from
		? ""
		: `
If the project's Cirrus packages were already updated, or it installs @getcirrus/pds from a local path, add --from <version> with the @getcirrus/pds version the project was on before. The work order then covers every release after that version.
`;
	return `Nothing was changed. This command looks like it is being run by a coding agent, so it did not prompt.

If the user asked you to upgrade this project, apply the plan above from ${plan.projectRoot}:

${applyCommand(plan)}

${writes} It does not edit the wrangler config or the worker source, set secrets, or deploy.

Then read the work order and follow it: assess every release entry, make the project changes it calls for, and build and check the project locally. Do not deploy unless the user has asked you to.
${from}
Add --dry-run to see the plan again, or --json to get it as JSON.
`;
}

/** Shown to a coding agent after the plan has been applied. */
export function agentNextSteps(plan: UpgradePlan): string {
	return `Read ${plan.guidePath} and follow it. It lists every release entry this upgrade crossed. Assess each one, make the project changes it calls for, then build and check the project locally with the commands in the file. Do not deploy unless the user has asked you to.
`;
}
