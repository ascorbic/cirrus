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
	ProjectDependency,
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
	fromVersions: Record<string, string>,
	fromPdsVersion: string,
	target: RegistryRelease,
): TransitiveChange[] {
	if (fromPdsVersion === target.version) return [];
	const direct = new Set(project.dependencies.map(({ name }) => name));
	return Object.entries(target.cirrusDependencies).flatMap(
		([name, toVersion]) => {
			const fromVersion = fromVersions[name];
			if (direct.has(name) || fromVersion === toVersion) return [];
			return [{ name, ...(fromVersion ? { fromVersion } : {}), toVersion }];
		},
	);
}

export async function createUpgradePlan(
	project: ProjectState,
	tag: string,
	fetcher: typeof fetch = fetch,
	from?: string,
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
	if (from !== undefined) {
		if (!pds) {
			throw new Error(
				`--from applies to ${PDS_PACKAGE}, which this project does not install from npm.`,
			);
		}
		if (semver.gt(from, pds.dependency.installedVersion)) {
			throw new Error(
				`--from ${from} is newer than the installed ${PDS_PACKAGE} ${pds.dependency.installedVersion}.`,
			);
		}
	}
	const startVersion = (dependency: ProjectDependency) =>
		from !== undefined && dependency.name === PDS_PACKAGE
			? from
			: dependency.installedVersion;
	// node_modules holds what is installed now; an earlier release's pins are only on npm.
	const transitiveFrom =
		pds && from !== undefined && from !== pds.dependency.installedVersion
			? (await resolveRegistryRelease(PDS_PACKAGE, from, fetcher))
					.cirrusDependencies
			: project.transitive;
	const transitive = pds
		? transitiveChanges(
				project,
				transitiveFrom,
				startVersion(pds.dependency),
				pds.release,
			)
		: [];

	const directRanges = releases
		.filter(
			({ dependency, release }) => startVersion(dependency) !== release.version,
		)
		.map(({ dependency, release }) =>
			fetchChangelogRange(
				requireRepository(release, tag),
				dependency.name,
				startVersion(dependency),
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
		...(from !== undefined ? { from } : {}),
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
