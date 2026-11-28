import semver from "semver";

import type { GitHubRepository } from "./types.js";

export interface RegistryRelease {
	name: string;
	version: string;
	repository?: GitHubRepository;
	/** `@getcirrus/*` dependencies pinned to an exact version, as Changesets publishes `workspace:*`. */
	cirrusDependencies: Record<string, string>;
}

/** npm has no such package, version, or dist-tag. */
export class ReleaseNotFoundError extends Error {}

const GITHUB_REPOSITORY = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i;

function githubRepository(value: unknown): GitHubRepository | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const url = Reflect.get(value, "url");
	const directory = Reflect.get(value, "directory");
	if (typeof url !== "string" || typeof directory !== "string") {
		return undefined;
	}
	const match = url.match(GITHUB_REPOSITORY);
	if (!match?.[1] || !match[2]) return undefined;
	return { owner: match[1], repo: match[2], directory };
}

function cirrusDependencies(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				entry[0].startsWith("@getcirrus/") &&
				typeof entry[1] === "string" &&
				semver.valid(entry[1]) !== null,
		),
	);
}

/** Resolves a dist-tag or an exact version of a package on npm. */
export async function resolveRegistryRelease(
	name: string,
	tagOrVersion: string,
	fetcher: typeof fetch = fetch,
): Promise<RegistryRelease> {
	const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(tagOrVersion)}`;
	const response = await fetcher(url, {
		headers: { Accept: "application/json", "User-Agent": "upgrade-pds" },
	});
	if (!response.ok) {
		const message = `npm could not resolve ${name}@${tagOrVersion} (${response.status} ${response.statusText}).`;
		throw response.status === 404
			? new ReleaseNotFoundError(message)
			: new Error(message);
	}
	const metadata: unknown = await response.json();
	const field = (key: string): unknown =>
		typeof metadata === "object" && metadata !== null
			? Reflect.get(metadata, key)
			: undefined;
	const version = field("version");
	if (field("name") !== name || typeof version !== "string") {
		throw new Error(
			`npm returned invalid metadata for ${name}@${tagOrVersion}.`,
		);
	}
	return {
		name,
		version,
		repository: githubRepository(field("repository")),
		cirrusDependencies: cirrusDependencies(field("dependencies")),
	};
}
