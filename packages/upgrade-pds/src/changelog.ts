import { posix } from "node:path";

import semver from "semver";

import type {
	ChangeCategory,
	ChangelogEntry,
	ChangelogOccurrence,
	GitHubRepository,
} from "./types.js";

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm;
const CATEGORY_HEADING = /^### (Major|Minor|Patch) Changes\s*$/gm;
const ENTRY_START = /^- /gm;
const CHANGESET_WRAPPER =
	/^- (?:(\[#\d+\]\((https:\/\/github\.com\/[^)]+)\)) )?(\[`[^`]+`\]\((https:\/\/github\.com\/[^)]+)\))(?: Thanks .+?!)? - /;

interface ParsedEntry {
	version: string;
	category: ChangeCategory;
	body: string;
	source?: string;
}

function category(value: string | undefined): ChangeCategory {
	switch (value) {
		case "Major":
			return "major";
		case "Minor":
			return "minor";
		default:
			return "patch";
	}
}

function sections(
	content: string,
	heading: RegExp,
): { title: string | undefined; content: string }[] {
	const headings = [...content.matchAll(heading)];
	return headings.map((match, index) => ({
		title: match[1],
		content: content.slice(
			match.index + match[0].length,
			headings[index + 1]?.index ?? content.length,
		),
	}));
}

function splitEntries(content: string): string[] {
	const starts = [...content.matchAll(ENTRY_START)];
	return starts.map((start, index) =>
		content
			.slice(start.index, starts[index + 1]?.index ?? content.length)
			.trim(),
	);
}

function normalizeEntry(
	entry: string,
): { body: string; source?: string } | null {
	if (entry.startsWith("- Updated dependencies [")) return null;
	const wrapper = entry.match(CHANGESET_WRAPPER);
	if (wrapper) {
		return {
			body: entry.slice(wrapper[0].length).trim(),
			source: wrapper[1] ?? wrapper[3],
		};
	}
	return { body: entry.slice(2).trim() };
}

export function parseChangelog(changelog: string): ParsedEntry[] {
	return sections(changelog, RELEASE_HEADING).flatMap((release) =>
		sections(release.content, CATEGORY_HEADING).flatMap((group) =>
			splitEntries(group.content).flatMap((entry) => {
				const normalized = normalizeEntry(entry);
				return normalized && release.title
					? [
							{
								version: release.title,
								category: category(group.title),
								...normalized,
							},
						]
					: [];
			}),
		),
	);
}

/**
 * Entries released after `currentVersion`, up to and including `targetVersion`.
 * Without a current version, the whole history up to the target.
 */
export function entriesBetween(
	changelog: string,
	currentVersion: string | undefined,
	targetVersion: string,
): ParsedEntry[] {
	const includePrereleases = semver.prerelease(targetVersion) !== null;
	return parseChangelog(changelog).filter(
		(entry) =>
			(includePrereleases || semver.prerelease(entry.version) === null) &&
			(currentVersion === undefined ||
				semver.gt(entry.version, currentVersion)) &&
			semver.lte(entry.version, targetVersion),
	);
}

export async function fetchChangelogRange(
	repository: GitHubRepository,
	packageName: string,
	currentVersion: string | undefined,
	targetVersion: string,
	fetcher: typeof fetch = fetch,
): Promise<ChangelogEntry[]> {
	const tag = `${packageName}@${targetVersion}`;
	const path = posix.join(repository.directory, "CHANGELOG.md");
	const url = `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/refs/tags/${encodeURIComponent(tag)}/${path.split("/").map(encodeURIComponent).join("/")}`;
	const response = await fetcher(url, {
		headers: { "User-Agent": "upgrade-pds" },
	});
	if (!response.ok) {
		throw new Error(
			`GitHub could not fetch ${repository.owner}/${repository.repo}/${path} at ${tag} (${response.status} ${response.statusText}).`,
		);
	}
	return deduplicateChangelog(
		entriesBetween(await response.text(), currentVersion, targetVersion).map(
			({ body, ...occurrence }) => ({
				body,
				occurrence: { packageName, ...occurrence },
			}),
		),
	);
}

export function deduplicateChangelog(
	entries: readonly { body: string; occurrence: ChangelogOccurrence }[],
): ChangelogEntry[] {
	const byBody = new Map<string, ChangelogEntry>();
	for (const entry of entries) {
		const existing = byBody.get(entry.body);
		if (existing) existing.occurrences.push(entry.occurrence);
		else {
			byBody.set(entry.body, {
				body: entry.body,
				occurrences: [entry.occurrence],
			});
		}
	}
	return [...byBody.values()];
}
