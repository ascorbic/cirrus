export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export type DependencySection =
	| "dependencies"
	| "devDependencies"
	| "optionalDependencies";

export interface GitHubRepository {
	owner: string;
	repo: string;
	directory: string;
}

export interface ProjectDependency {
	name: string;
	section: DependencySection;
	specifier: string;
	installedVersion: string;
}

export interface DependencyChange {
	name: string;
	section: DependencySection;
	from: string;
	to: string;
	fromVersion: string;
	toVersion: string;
}

/** A direct Cirrus dependency whose specifier the project manages itself. */
export interface SkippedDependency {
	name: string;
	specifier: string;
	reason: string;
}

/** A Cirrus package installed through `@getcirrus/pds`, not declared by the project. */
export interface TransitiveChange {
	name: string;
	/** Absent when the package was not a dependency of the installed release. */
	fromVersion?: string;
	toVersion: string;
}

export type ChangeCategory = "major" | "minor" | "patch";

export interface ChangelogOccurrence {
	packageName: string;
	version: string;
	category: ChangeCategory;
	source?: string;
}

export interface ChangelogEntry {
	body: string;
	occurrences: ChangelogOccurrence[];
}

export interface UpgradePlan {
	projectRoot: string;
	packageManager: PackageManager;
	tag: string;
	/** The `@getcirrus/pds` version the release entries start after, when it is not the installed one. */
	from?: string;
	/** Whether `from` was given with `--from` or read from the deployed PDS. */
	fromSource?: "option" | "deployed";
	/** The version the project's production PDS reports, when it answers. */
	deployed?: { hostname: string; version: string };
	dependencies: DependencyChange[];
	skipped: SkippedDependency[];
	transitive: TransitiveChange[];
	changelog: ChangelogEntry[];
	/** The `create-pds` project template at the target release tag. */
	referenceProject?: string;
	guidePath: string;
	commands: {
		install: string;
		build?: string;
		dev?: string;
		deploy?: string;
		statusDev: string;
		status: string;
	};
}
