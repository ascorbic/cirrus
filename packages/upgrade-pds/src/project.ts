import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import { applyEdits, modify } from "jsonc-parser";

import type {
	DependencyChange,
	DependencySection,
	PackageManager,
	ProjectDependency,
} from "./types.js";

export const PDS_PACKAGE = "@getcirrus/pds";
const CIRRUS_SCOPE = "@getcirrus/";

export interface ProjectPackage {
	[key: string]: unknown;
	packageManager?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export interface ProjectState {
	root: string;
	/** Where the package manager keeps its lockfile; the project root unless it is in a workspace. */
	lockfileDirectory: string;
	packageJsonPath: string;
	packageJsonSource: string;
	packageJson: ProjectPackage;
	packageManager: PackageManager;
	dependencies: ProjectDependency[];
}

export type Run = (
	command: string,
	args: readonly string[],
	cwd: string,
) => Promise<void>;

const SECTIONS: readonly DependencySection[] = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];
const LOCKFILES: Record<PackageManager, readonly string[]> = {
	pnpm: ["pnpm-lock.yaml"],
	bun: ["bun.lock", "bun.lockb"],
	yarn: ["yarn.lock"],
	npm: ["package-lock.json"],
};
const PROJECT_MANAGED_SPECIFIER =
	/^(?:catalog|workspace|link|file|portal|npm):/;
const SIMPLE_VERSION = /^(\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function isProjectPackage(value: unknown): value is ProjectPackage {
	if (typeof value !== "object" || value === null) return false;
	const packageManager = Reflect.get(value, "packageManager");
	if (packageManager !== undefined && typeof packageManager !== "string") {
		return false;
	}
	return ["scripts", ...SECTIONS].every((key) => {
		const entry = Reflect.get(value, key);
		return entry === undefined || isStringRecord(entry);
	});
}

function isPackageManager(value: string | undefined): value is PackageManager {
	return (
		value === "npm" || value === "pnpm" || value === "yarn" || value === "bun"
	);
}

function* ancestors(start: string): Generator<string> {
	const filesystemRoot = parse(start).root;
	for (let current = start; ; current = dirname(current)) {
		yield current;
		if (current === filesystemRoot) return;
	}
}

async function findProjectRoot(start: string): Promise<string> {
	for (const directory of ancestors(resolve(start))) {
		if (await pathExists(resolve(directory, "package.json"))) return directory;
	}
	throw new Error("Could not find a project package.json.");
}

async function hasLockfile(
	directory: string,
	packageManager: PackageManager,
): Promise<boolean> {
	for (const lockfile of LOCKFILES[packageManager]) {
		if (await pathExists(resolve(directory, lockfile))) return true;
	}
	return false;
}

export async function detectPackageManager(
	root: string,
	declaration?: string,
): Promise<{ packageManager: PackageManager; lockfileDirectory: string }> {
	const declared = declaration?.split("@")[0];
	const candidates: readonly PackageManager[] = isPackageManager(declared)
		? [declared]
		: ["pnpm", "bun", "yarn", "npm"];
	for (const directory of ancestors(root)) {
		for (const packageManager of candidates) {
			if (await hasLockfile(directory, packageManager)) {
				return { packageManager, lockfileDirectory: directory };
			}
		}
	}
	return {
		packageManager: isPackageManager(declared) ? declared : "npm",
		lockfileDirectory: root,
	};
}

async function installedVersion(root: string, name: string): Promise<string> {
	for (const directory of ancestors(root)) {
		const candidate = resolve(
			directory,
			"node_modules",
			...name.split("/"),
			"package.json",
		);
		if (!(await pathExists(candidate))) continue;
		const value: unknown = JSON.parse(await readFile(candidate, "utf8"));
		const version =
			typeof value === "object" && value !== null
				? Reflect.get(value, "version")
				: null;
		if (typeof version !== "string") {
			throw new Error(`${name} has no installed version.`);
		}
		return version;
	}
	throw new Error(
		`Install the project's dependencies before running upgrade-pds (${name} is missing).`,
	);
}

export async function loadProject(start: string): Promise<ProjectState> {
	const root = await findProjectRoot(start);
	const packageJsonPath = resolve(root, "package.json");
	const packageJsonSource = await readFile(packageJsonPath, "utf8");
	const packageJson: unknown = JSON.parse(packageJsonSource);
	if (!isProjectPackage(packageJson)) {
		throw new Error("The project package.json is invalid.");
	}
	const declared = SECTIONS.flatMap((section) =>
		Object.entries(packageJson[section] ?? {})
			.filter(([name]) => name.startsWith(CIRRUS_SCOPE))
			.map(([name, specifier]) => ({ name, section, specifier })),
	);
	if (!declared.some((dependency) => dependency.name === PDS_PACKAGE)) {
		throw new Error(
			`The project at ${root} does not declare ${PDS_PACKAGE} as a direct dependency.`,
		);
	}
	const { packageManager, lockfileDirectory } = await detectPackageManager(
		root,
		packageJson.packageManager,
	);
	if (await pathExists(resolve(lockfileDirectory, ".pnp.cjs"))) {
		throw new Error(
			"This project uses Yarn Plug'n'Play, which installs packages without node_modules. upgrade-pds needs a node_modules install: set nodeLinker: node-modules in .yarnrc.yml and run yarn install.",
		);
	}
	const dependencies: ProjectDependency[] = [];
	for (const dependency of declared) {
		dependencies.push({
			...dependency,
			installedVersion: await installedVersion(root, dependency.name),
		});
	}
	return {
		root,
		lockfileDirectory,
		packageJsonPath,
		packageJsonSource,
		packageJson,
		packageManager,
		dependencies,
	};
}

export function targetSpecifier(
	current: string,
	targetVersion: string,
): string | null {
	if (PROJECT_MANAGED_SPECIFIER.test(current)) return null;
	const match = current.match(SIMPLE_VERSION);
	if (!match) return `^${targetVersion}`;
	return `${match[1] ?? ""}${targetVersion}`;
}

export function unsupportedSpecifierReason(specifier: string): string {
	if (specifier.startsWith("workspace:")) {
		return "it comes from a package in this workspace, not from npm";
	}
	if (specifier.startsWith("catalog:")) {
		return "its version is set in a pnpm catalog";
	}
	if (specifier.startsWith("npm:")) {
		return "it is an alias for another package";
	}
	return "it is installed from a local path";
}

export function applyDependencyEdits(
	packageJsonSource: string,
	changes: readonly DependencyChange[],
): string {
	let updated = packageJsonSource;
	for (const change of changes) {
		updated = applyEdits(
			updated,
			modify(updated, [change.section, change.name], change.to, {}),
		);
	}
	return updated;
}

export function installCommand(packageManager: PackageManager): string {
	return `${packageManager} install`;
}

export function runScript(
	packageManager: PackageManager,
	script: string,
): string {
	return `${packageManager} run ${script}`;
}

export function execCommand(
	packageManager: PackageManager,
	command: string,
): string {
	switch (packageManager) {
		case "bun":
			return `bunx ${command}`;
		case "npm":
			return `npm exec -- ${command}`;
		case "pnpm":
			return `pnpm exec ${command}`;
		case "yarn":
			return `yarn ${command}`;
	}
}

export const run: Run = (command, args, cwd) =>
	new Promise((resolvePromise, reject) => {
		// Package manager commands are .cmd shims on Windows, which Node only runs through a shell.
		const child =
			process.platform === "win32"
				? spawn([command, ...args].join(" "), {
						cwd,
						stdio: "inherit",
						shell: true,
					})
				: spawn(command, args, { cwd, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else {
				reject(
					new Error(
						`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`,
					),
				);
			}
		});
	});

interface FileSnapshot {
	path: string;
	source: string | Buffer | null;
}

async function restoreFiles(files: readonly FileSnapshot[]): Promise<void> {
	for (const file of files) {
		if (file.source !== null) await writeFile(file.path, file.source);
		else await rm(file.path, { force: true });
	}
}

export async function writeDependenciesAndInstall<T>(
	project: ProjectState,
	changes: readonly DependencyChange[],
	verify: () => Promise<T>,
	runCommand: Run = run,
): Promise<T> {
	if (changes.length === 0) return verify();
	const install = () =>
		runCommand(project.packageManager, ["install"], project.root);
	const snapshots: FileSnapshot[] = [
		{ path: project.packageJsonPath, source: project.packageJsonSource },
	];
	for (const name of LOCKFILES[project.packageManager]) {
		const path = resolve(project.lockfileDirectory, name);
		snapshots.push({
			path,
			source: (await pathExists(path)) ? await readFile(path) : null,
		});
	}
	await writeFile(
		project.packageJsonPath,
		applyDependencyEdits(project.packageJsonSource, changes),
	);
	try {
		await install();
		return await verify();
	} catch (error) {
		await restoreFiles(snapshots);
		const message = error instanceof Error ? error.message : String(error);
		try {
			await install();
		} catch {
			throw new Error(
				`${message} package.json and the lockfile were restored, but reinstalling the previous dependencies failed. Run ${installCommand(project.packageManager)} in ${project.root}.`,
				{ cause: error },
			);
		}
		throw new Error(`${message} The previous dependencies were restored.`, {
			cause: error,
		});
	}
}
