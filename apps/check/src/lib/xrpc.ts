import "@atcute/atproto";
import { Client, simpleFetchHandler } from "@atcute/client";
import {
	safeParse,
	type BaseSchema,
	type Issue,
} from "@atcute/lexicons/validations";
import type { OAuthUserAgent } from "@atcute/oauth-browser-client";
import type { CheckOutcome } from "../types";

export function publicClient(pds: string): Client {
	return new Client({ handler: simpleFetchHandler({ service: pds }) });
}

export function authedClient(agent: OAuthUserAgent): Client {
	return new Client({ handler: agent });
}

function formatPath(path: readonly (string | number)[]): string {
	if (path.length === 0) return "(root)";
	let out = "";
	for (const seg of path) {
		if (typeof seg === "number") out += `[${seg}]`;
		else out += out ? `.${seg}` : seg;
	}
	return out;
}

function summarizeIssue(issue: Issue): string {
	const path = formatPath(issue.path);
	switch (issue.code) {
		case "missing_value":
			return `${path}: required field missing`;
		case "invalid_type":
			return `${path}: expected ${issue.expected}`;
		case "invalid_literal":
			return `${path}: expected one of ${issue.expected.join(", ")}`;
		case "invalid_variant":
			return `${path}: expected variant ${issue.expected.join(" | ")}`;
		case "invalid_string_format":
			return `${path}: not a valid ${issue.expected}`;
		case "invalid_string_length":
			return `${path}: string length must be ${issue.minLength}..${issue.maxLength}`;
		case "invalid_string_graphemes":
			return `${path}: grapheme count must be ${issue.minGraphemes}..${issue.maxGraphemes}`;
		case "invalid_array_length":
			return `${path}: array length must be ${issue.minLength}..${issue.maxLength}`;
		case "invalid_integer_range":
			return `${path}: must be in [${issue.min}, ${issue.max}]`;
		case "invalid_bytes_size":
			return `${path}: byte size must be ${issue.minSize}..${issue.maxSize}`;
		case "invalid_blob_size":
			return `${path}: blob size must be ≤ ${issue.maxSize}`;
		case "invalid_blob_mime_type":
			return `${path}: mime type must be one of ${issue.accept.join(", ")}`;
	}
}

export function validateLexicon(
	schema: BaseSchema,
	data: unknown,
): CheckOutcome {
	const result = safeParse(schema, data);
	if (result.ok) {
		return {
			status: "pass",
			message: "response matches lexicon",
		};
	}
	const summaries = result.issues.map(summarizeIssue);
	return {
		status: "fail",
		message:
			summaries.length === 1
				? summaries[0]!
				: `${summaries.length} validation issues — ${summaries[0]}`,
		evidence: {
			actual: data,
			error: summaries.join("\n"),
		},
	};
}
