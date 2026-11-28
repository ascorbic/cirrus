import { resolve } from "node:path";

import semver from "semver";

import { deduplicateChangelog, fetchChangelogRange } from "./changelog.js";
import {
	execCommand,
	installCommand,
	PDS_PACKAGE,
	runScript,
	targetSpecifier,
	unsupportedSpecifierReason,
	type ProjectState,
} from "./project.js";
import {
	ReleaseNotFoundError,
	resolveRegistryRelease,
	type RegistryRelease,
} from "./registry.js";
import type {
	ChangelogEntry,
	DependencyChange,
	GitHubRepository,
	SkippedDependency,
	TransitiveChange,
	UpgradePlan,
} from "./types.js";

const TEMPLATE_DIRECTORY = "packages/create-pds/templates/pds-worker";

function requireRepository(
	release: RegistryRelease,
	tag: string,
): GitHubRepository {
	if (!release.repository) {
		throw new Error(
			`${release.name}@${tag} does not publish a GitHub repository directory, so its changelog cannot be fetched.`,
		);
	}
	return release.repository;
}

function transitiveChanges(
	project: ProjectState,
	installedPdsVersion: string,
	target: RegistryRelease,
): TransitiveChange[] {
	if (installedPdsVersion === target.version) return [];
	const direct = new Set(project.dependencies.map(({ name }) => name));
	return Object.entries(target.cirrusDependencies).flatMap(
		([name, toVersion]) => {
			const fromVersion = project.transitive[name];
			if (direct.has(name) || fromVersion === toVersion) return [];
			return [{ name, ...(fromVersion ? { fromVersion } : {}), toVersion }];
		},
	);
}

export async function createUpgradePlan(
	project: ProjectState,
	tag: string,
	fetcher: typeof fetch = fetch,
): Promise<UpgradePlan> {
	const skipped: SkippedDependency[] = [];
	const upgradable = project.dependencies.filter((dependency) => {
		if (targetSpecifier(dependency.specifier, "0.0.0") !== null) return true;
		skipped.push({
			name: dependency.name,
			specifier: dependency.specifier,
			reason: unsupportedSpecifierReason(dependency.specifier),
		});
		return false;
	});
	const resolved = await Promise.all(
		upgradable.map(async (dependency) => {
			try {
				return {
					dependency,
					release: await resolveRegistryRelease(dependency.name, tag, fetcher),
				};
			} catch (error) {
				if (
					!(error instanceof ReleaseNotFoundError) ||
					dependency.name === PDS_PACKAGE
				) {
					throw error;
				}
				skipped.push({
					name: dependency.name,
					specifier: dependency.specifier,
					reason: `it has no ${tag} release on npm`,
				});
				return [];
			}
		}),
	);
	const releases = resolved.flat();

	const dependencies: DependencyChange[] = releases.flatMap(
		({ dependency, release }) => {
			if (
				!semver.valid(dependency.installedVersion) ||
				!semver.valid(release.version)
			) {
				throw new Error(
					`Cannot compare ${dependency.name} ${dependency.installedVersion} with ${release.version}.`,
				);
			}
			if (semver.gt(dependency.installedVersion, release.version)) {
				throw new Error(
					`${dependency.name}@${tag} is ${release.version}, older than the installed ${dependency.installedVersion}.`,
				);
			}
			const to = targetSpecifier(dependency.specifier, release.version);
			if (
				to === null ||
				(dependency.installedVersion === release.version &&
					to === dependency.specifier)
			) {
				return [];
			}
			return [
				{
					name: dependency.name,
					section: dependency.section,
					from: dependency.specifier,
					to,
					fromVersion: dependency.installedVersion,
					toVersion: release.version,
				},
			];
		},
	);

	const pds = releases.find(
		({ dependency }) => dependency.name === PDS_PACKAGE,
	);
	const transitive = pds
		? transitiveChanges(project, pds.dependency.installedVersion, pds.release)
		: [];

	const directRanges = releases
		.filter(
			({ dependency, release }) =>
				dependency.installedVersion !== release.version,
		)
		.map(({ dependency, release }) =>
			fetchChangelogRange(
				requireRepository(release, tag),
				dependency.name,
				dependency.installedVersion,
				release.version,
				fetcher,
			),
		);
	const transitiveRanges = transitive.map(async (change) =>
		fetchChangelogRange(
			requireRepository(
				await resolveRegistryRelease(change.name, change.toVersion, fetcher),
				change.toVersion,
			),
			change.name,
			change.fromVersion,
			change.toVersion,
			fetcher,
		),
	);
	const ranges: ChangelogEntry[][] = await Promise.all([
		...directRanges,
		...transitiveRanges,
	]);
	const changelog = deduplicateChangelog(
		ranges.flatMap((entries) =>
			entries.flatMap((entry) =>
				entry.occurrences.map((occurrence) => ({
					body: entry.body,
					occurrence,
				})),
			),
		),
	);

	const repository = pds?.release.repository;
	const scripts = project.packageJson.scripts ?? {};
	const script = (name: string) =>
		scripts[name] ? runScript(project.packageManager, name) : undefined;
	return {
		projectRoot: project.root,
		packageManager: project.packageManager,
		tag,
		dependencies,
		skipped,
		transitive,
		changelog,
		referenceProject:
			repository && pds
				? `https://github.com/${repository.owner}/${repository.repo}/tree/${PDS_PACKAGE}@${pds.release.version}/${TEMPLATE_DIRECTORY}`
				: undefined,
		guidePath: resolve(project.root, ".cirrus", "UPGRADE.md"),
		commands: {
			install: installCommand(project.packageManager),
			build: script("build"),
			dev: script("dev"),
			deploy: script("deploy"),
			statusDev: execCommand(project.packageManager, "pds status --dev"),
			status: execCommand(project.packageManager, "pds status"),
		},
	};
}
