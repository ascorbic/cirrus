import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ChangelogEntry, UpgradePlan } from "./types.js";

function codeBlock(commands: readonly string[]): string {
	return `\`\`\`sh\n${commands.join("\n")}\n\`\`\``;
}

function renderEntry(entry: ChangelogEntry, index: number): string {
	const appliesTo = [
		...new Set(
			entry.occurrences.map(
				(occurrence) =>
					`\`${occurrence.packageName}@${occurrence.version}\` (${occurrence.category})`,
			),
		),
	].join(", ");
	const sources = [
		...new Set(entry.occurrences.flatMap(({ source }) => source ?? [])),
	];
	return `#### Change ${index + 1}

Applies to: ${appliesTo}${sources.length > 0 ? `  \nSource: ${sources.join(", ")}` : ""}

${entry.body}`;
}

function releaseHeading(entry: ChangelogEntry): string {
	const first = entry.occurrences[0];
	return first ? `### \`${first.packageName}\` ${first.version}` : "";
}

function renderEntries(changelog: readonly ChangelogEntry[]): string {
	return changelog
		.map((entry, index) => {
			const heading = releaseHeading(entry);
			const previous = changelog[index - 1];
			const rendered = renderEntry(entry, index);
			return previous && releaseHeading(previous) === heading
				? rendered
				: `${heading}\n\n${rendered}`;
		})
		.join("\n\n");
}

function renderPackages(plan: UpgradePlan): string {
	const lines =
		plan.dependencies.length > 0
			? plan.dependencies.map(
					(change) =>
						`- \`${change.name}\`: \`${change.fromVersion}\` → \`${change.toVersion}\` (\`${change.from}\` → \`${change.to}\`)${
							plan.from &&
							change.name === "@getcirrus/pds" &&
							plan.from !== change.fromVersion
								? `, with release entries from \`${plan.from}\``
								: ""
						}`,
				)
			: [
					`All direct Cirrus packages were already on the \`${plan.tag}\` release.`,
				];
	const skipped = plan.skipped.map(
		(dependency) =>
			`- \`${dependency.name}\` (\`${dependency.specifier}\`) was not changed: ${dependency.reason}.`,
	);
	const transitive =
		plan.transitive.length > 0
			? `\n\nInstalled through \`@getcirrus/pds\`${plan.from ? `, compared with its \`${plan.from}\` release` : ""}:\n\n${plan.transitive
					.map((change) =>
						change.fromVersion
							? `- \`${change.name}\`: \`${change.fromVersion}\` → \`${change.toVersion}\``
							: `- \`${change.name}\`: added at \`${change.toVersion}\``,
					)
					.join("\n")}`
			: "";
	return `${[...lines, ...skipped].join("\n")}${transitive}`;
}

function renderReference(plan: UpgradePlan): string {
	if (!plan.referenceProject) return "";
	return `## Reference project

The project template for the target release is at:

${plan.referenceProject}

When a release entry mentions project configuration, compare this project's \`wrangler.jsonc\`, worker entry (\`src/index.ts\`), and \`vite.config.ts\` against the template, and its \`package.json\` against the template's \`package.json.tmpl\`. The template shows every optional feature configured. Keep this project's own names, routes, vars, and bucket names.

`;
}

function renderDeploy(plan: UpgradePlan): string {
	const { commands } = plan;
	const build = commands.build
		? `Build the project:\n\n${codeBlock([commands.build])}`
		: "Build the project with its own build command.";
	const dev = commands.dev
		? `Start the local dev server and leave it running:\n\n${codeBlock([commands.dev])}\n\nWait until it answers at \`/xrpc/_health\` on the URL it prints. Then, in another shell, check it:`
		: "Start the project locally, wait until it answers at `/xrpc/_health`, then check it:";
	const deploy = commands.deploy
		? `Deploy:\n\n${codeBlock([commands.deploy])}`
		: "Deploy with the project's deployment workflow. On Cloudflare Workers, run `wrangler deploy` after building.";
	return `## Build, deploy, verify

${build}

${dev}

${codeBlock([commands.statusDev])}

A human should review the changes before the deploy. Durable Object migration tags in the wrangler config are append-only: add a tag after the last one, and never edit or remove a tag that has been deployed.

${deploy}

Check production:

${codeBlock([commands.status])}

To roll back, reinstall the previous package versions listed above and deploy again. A Durable Object class migration that has been deployed stays deployed, and storage that a release has migrated is not migrated back.`;
}

export function renderUpgradeGuide(plan: UpgradePlan): string {
	const changes =
		plan.changelog.length > 0
			? renderEntries(plan.changelog)
			: "No release entries were crossed by this update.";
	return `# Cirrus upgrade work order

This file is the handoff for upgrading the Cirrus PDS project at \`${plan.projectRoot}\` to the npm \`${plan.tag}\` release.${plan.deployed ? ` Production at \`${plan.deployed.hostname}\` reports \`@getcirrus/pds\` \`${plan.deployed.version}\`.` : ""}${plan.from ? ` It covers the releases after \`@getcirrus/pds\` \`${plan.from}\`, the version ${plan.fromSource === "deployed" ? "production is running" : "given with \`--from\`"}.` : ""} ${plan.dependencies.length > 0 ? "The updater changed the Cirrus packages listed below and installed them." : "The updater did not change any package."} It did not edit the wrangler config or the worker source, set a secret, or deploy.

## Package changes

${renderPackages(plan)}

## Release entries to assess

These are the complete authored major, minor, and patch entries crossed by this upgrade. Generated dependency-bump entries and attribution have been removed. Check whether each entry requires a change to this project's configuration, worker entry, secrets, or Cloudflare resources, and make that change. Do not enable an optional feature merely because it appears here.

Entries are grouped by the release that introduced them, oldest release first within each package. A later entry can replace what an earlier one asks for, so read them all before changing anything.

${changes}

${renderReference(plan)}${renderDeploy(plan)}
`;
}

/**
 * Writes the work order, and a `.gitignore` that keeps its directory out of
 * the project's repository. `undo` puts back what was there before.
 */
export async function writeUpgradeGuide(
	plan: UpgradePlan,
): Promise<{ undo: () => Promise<void> }> {
	const directory = dirname(plan.guidePath);
	const ignorePath = resolve(directory, ".gitignore");
	const previousGuide = await readFile(plan.guidePath).catch(() => null);
	const createdDirectory =
		(await mkdir(directory, { recursive: true })) !== undefined;
	const createdIgnore = await writeFile(ignorePath, "*\n", { flag: "wx" }).then(
		() => true,
		() => false,
	);
	await writeFile(plan.guidePath, renderUpgradeGuide(plan));
	return {
		async undo() {
			if (previousGuide) await writeFile(plan.guidePath, previousGuide);
			else await rm(plan.guidePath, { force: true });
			if (createdIgnore) await rm(ignorePath, { force: true });
			if (createdDirectory) await rmdir(directory);
		},
	};
}
