import semver from "semver";

const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function validateOptions(options: {
	tag: string;
	json: boolean;
	yes: boolean;
}): void {
	if (options.json && options.yes) {
		throw new Error(
			"--json reports the plan without applying it and cannot be combined with --yes.",
		);
	}
	if (!DIST_TAG.test(options.tag) || semver.validRange(options.tag)) {
		throw new Error(
			"--to accepts an npm dist-tag such as latest or next, not a version.",
		);
	}
}
