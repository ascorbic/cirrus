import { resolve } from "node:path";

import semver from "semver";

import { deduplicateChangelog, fetchChangelogRange } from "./changelog.js";
import { fetchDeployedVersion } from "./deployed.js";
import {
	execCommand,
	installCommand,
	isLocalSource,
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
	direct: readonly DependencyChange[],
	fromVersions: Record<string, string>,
	fromPdsVersion: string,
	target: RegistryRelease,
): TransitiveChange[] {
	if (fromPdsVersion === target.version) return [];
	return Object.entries(target.cirrusDependencies).flatMap(
		([name, toVersion]) => {
			const fromVersion = fromVersions[name];
			// The project's own copy can sit on a different version from the one
			// inside pds, so only an identical move is already accounted for.
			const covered = direct.some(
				(change) =>
					change.name === name &&
					change.fromVersion === fromVersion &&
					change.toVersion === toVersion,
			);
			if (covered || fromVersion === toVersion) return [];
			return [{ name, ...(fromVersion ? { fromVersion } : {}), toVersion }];
		},
	);
}

/** The deployed version, when it is an earlier release than the one installed from npm. */
function deployedBaseline(
	project: ProjectState,
	deployedVersion: string | undefined,
): string | undefined {
	const pds = project.dependencies.find(({ name }) => name === PDS_PACKAGE);
	if (
		!deployedVersion ||
		!pds ||
		targetSpecifier(pds.specifier, "0.0.0") === null ||
		!semver.valid(pds.installedVersion) ||
		!semver.lt(deployedVersion, pds.installedVersion)
	) {
		return undefined;
	}
	return deployedVersion;
}

export async function createUpgradePlan(
	project: ProjectState,
	tag: string,
	fetcher: typeof fetch = fetch,
	requestedFrom?: string,
): Promise<UpgradePlan> {
	const skipped: SkippedDependency[] = [];
	const deployedVersion = project.pdsHostname
		? await fetchDeployedVersion(project.pdsHostname, fetcher)
		: undefined;
	const from = requestedFrom ?? deployedBaseline(project, deployedVersion);
	const replacesLocalPds = (dependency: ProjectDependency) =>
		requestedFrom !== undefined &&
		dependency.name === PDS_PACKAGE &&
		isLocalSource(dependency.specifier);
	const startVersion = (dependency: ProjectDependency) =>
		from !== undefined && dependency.name === PDS_PACKAGE
			? from
			: dependency.installedVersion;
	const upgradable = project.dependencies.filter((dependency) => {
		if (
			targetSpecifier(dependency.specifier, "0.0.0") !== null ||
			replacesLocalPds(dependency)
		) {
			return true;
		}
		const { name, specifier } = dependency;
		const reason = unsupportedSpecifierReason(specifier);
		if (dependency.name !== PDS_PACKAGE) {
			skipped.push({ name, specifier, reason });
			return false;
		}
		if (requestedFrom !== undefined) {
			throw new Error(
				`--from cannot move ${PDS_PACKAGE} (${dependency.specifier}) to npm: ${reason}.`,
			);
		}
		skipped.push({
			name,
			specifier,
			reason: isLocalSource(dependency.specifier)
				? `${reason}; pass --from <version> to replace it with the npm release`
				: reason,
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
			// A local copy's own version says nothing about which release the project was on.
			const current = replacesLocalPds(dependency)
				? startVersion(dependency)
				: dependency.installedVersion;
			if (!semver.valid(current) || !semver.valid(release.version)) {
				throw new Error(
					`Cannot compare ${dependency.name} ${current} with ${release.version}.`,
				);
			}
			if (semver.gt(current, release.version)) {
				throw new Error(
					`${dependency.name}@${tag} is ${release.version}, older than the installed ${current}.`,
				);
			}
			const to =
				targetSpecifier(dependency.specifier, release.version) ??
				(replacesLocalPds(dependency) ? `^${release.version}` : null);
			if (
				to === null ||
				(current === release.version && to === dependency.specifier)
			) {
				return [];
			}
			return [
				{
					name: dependency.name,
					section: dependency.section,
					from: dependency.specifier,
					to,
					fromVersion: current,
					toVersion: release.version,
				},
			];
		},
	);

	const pds = releases.find(
		({ dependency }) => dependency.name === PDS_PACKAGE,
	);
	if (
		pds &&
		requestedFrom !== undefined &&
		!replacesLocalPds(pds.dependency) &&
		semver.gt(requestedFrom, pds.dependency.installedVersion)
	) {
		throw new Error(
			`--from ${requestedFrom} is newer than the installed ${PDS_PACKAGE} ${pds.dependency.installedVersion}.`,
		);
	}
	// node_modules holds what is installed now; an earlier release's pins are only on npm.
	const transitiveFrom =
		pds && from !== undefined
			? (await resolveRegistryRelease(PDS_PACKAGE, from, fetcher))
					.cirrusDependencies
			: project.transitive;
	const transitive = pds
		? transitiveChanges(
				dependencies,
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
	const packageOrder = [
		...releases.map(({ dependency }) => dependency.name),
		...transitive.map(({ name }) => name),
	];
	const changelog = deduplicateChangelog(
		ranges
			.flatMap((entries) =>
				entries.flatMap((entry) =>
					entry.occurrences.map((occurrence) => ({
						body: entry.body,
						occurrence,
					})),
				),
			)
			.sort(
				(a, b) =>
					packageOrder.indexOf(a.occurrence.packageName) -
						packageOrder.indexOf(b.occurrence.packageName) ||
					semver.compare(a.occurrence.version, b.occurrence.version),
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
		...(from !== undefined
			? {
					from,
					fromSource: requestedFrom !== undefined ? "option" : "deployed",
				}
			: {}),
		...(project.pdsHostname && deployedVersion
			? {
					deployed: { hostname: project.pdsHostname, version: deployedVersion },
				}
			: {}),
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
