#!/usr/bin/env node
/**
 * space-conformance CLI.
 *
 *   space-conformance run --target https://host [--did did:...] \
 *     [--handle alice.example.com] [--oauth] [--standalone-host] \
 *     [--destructive] [--tier must,should] [--report out.json] [--json]
 *   space-conformance coverage [--json]
 *
 * Operator auth (any one of):
 *   --oauth --handle you.example.com — browser sign-in via the atproto
 *     OAuth loopback flow; no password ever touches this process. Works
 *     against any PDS with an OAuth server.
 *   --handle + password — signs in via com.atproto.server.createSession;
 *     the password comes from SPACE_CONFORMANCE_PASSWORD or an interactive
 *     hidden prompt, never argv. Use the main password: app passwords are
 *     refused on space routes.
 *   SPACE_CONFORMANCE_TOKEN env — a bearer the target accepts (a session
 *     accessJwt, or a deployment-specific static token).
 *   --operator-token TOKEN — same, via argv; prefer the env var, since
 *     argv leaks into shell history and process listings.
 *
 * Exit code is non-zero when any `must` check fails or errors, so it
 * gates CI.
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { coverageReport } from "../coverage.js";
import { fullCatalog } from "../full.js";
import { renderReport } from "../runner.js";
import { runConformance } from "./run.js";
import { oauthSignIn, type OAuthOperator } from "./oauth.js";
import type { Tier } from "../model.js";

/**
 * Read a password from the terminal with echo suppressed. Only offered on
 * a TTY — a piped stdin gets the env-var error instead, so scripts fail
 * loudly rather than hanging on a prompt nobody sees.
 */
function promptPassword(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		const stderr = process.stderr;
		stderr.write(prompt);
		const rl = createInterface({ input: stdin, terminal: true });
		// Suppress echo: readline writes keystrokes via its output stream;
		// giving it none and muting is fiddly, so toggle raw handling simply —
		// print nothing per keypress by not attaching an output stream.
		rl.question("", (answer) => {
			stderr.write("\n");
			rl.close();
			resolve(answer);
		});
		rl.on("error", reject);
	});
}

function suiteVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(
			readFileSync(join(here, "..", "package.json"), "utf8"),
		) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function parseTiers(value: string | undefined): Tier[] | undefined {
	if (!value) return undefined;
	const tiers = value.split(",").map((t) => t.trim()) as Tier[];
	for (const tier of tiers) {
		if (tier !== "must" && tier !== "should" && tier !== "info") {
			throw new Error(`unknown tier: ${tier}`);
		}
	}
	return tiers;
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0];

	if (command === "coverage") {
		const { values } = parseArgs({
			args: argv.slice(1),
			options: { json: { type: "boolean" } },
		});
		const report = coverageReport(fullCatalog);
		if (values.json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(
				`${report.covered.length}/${report.requirements.length} requirements covered, ${report.gaps.length} gaps\n`,
			);
			for (const gap of report.gaps) {
				process.stdout.write(`  gap: ${gap.ref}\n`);
			}
			for (const d of report.danglingCitations) {
				process.stdout.write(`  dangling: ${d.checkId} → ${d.ref}\n`);
			}
		}
		return report.danglingCitations.length > 0 ? 1 : 0;
	}

	if (command === "run") {
		const { values } = parseArgs({
			args: argv.slice(1),
			options: {
				target: { type: "string" },
				did: { type: "string" },
				implementation: { type: "string" },
				"operator-token": { type: "string" },
				handle: { type: "string" },
				oauth: { type: "boolean" },
				"standalone-host": { type: "boolean" },
				identities: { type: "boolean" },
				destructive: { type: "boolean" },
				slow: { type: "boolean" },
				tier: { type: "string" },
				report: { type: "string" },
				json: { type: "boolean" },
			},
		});
		if (!values.target) {
			process.stderr.write("run requires --target <origin>\n");
			return 2;
		}

		const origin = values.target.replace(/\/+$/, "");
		const operatorToken =
			values["operator-token"] ?? process.env.SPACE_CONFORMANCE_TOKEN;

		// The browser OAuth flow: no password ever enters this process, and
		// the session is DPoP-bound (unusable as a plain bearer).
		let oauthOperator: OAuthOperator | undefined;
		if (values.oauth) {
			if (!values.handle) {
				process.stderr.write("--oauth requires --handle <your handle>\n");
				return 2;
			}
			oauthOperator = await oauthSignIn({
				handle: values.handle,
				targetOrigin: origin,
				log: (message) => process.stderr.write(`${message}\n`),
			});
		}

		// Secrets come from the environment or an interactive hidden prompt,
		// never argv — argv leaks into shell history and process listings.
		// (--operator-token remains for CI where the value already lives in a
		// secret store, but SPACE_CONFORMANCE_TOKEN is the recommended route.)
		let password = process.env.SPACE_CONFORMANCE_PASSWORD;
		if (
			!password &&
			values.handle &&
			!values.oauth &&
			!operatorToken &&
			process.stdin.isTTY
		) {
			password = await promptPassword(`Password for ${values.handle}: `);
		}

		const report = await runConformance({
			origin,
			did: values.did,
			implementation: values.implementation,
			operatorToken,
			operatorFetch: oauthOperator?.fetch,
			handle: values.handle,
			password,
			standaloneHost: values["standalone-host"],
			identities: values.identities,
			destructive: values.destructive,
			slow: values.slow,
			tiers: parseTiers(values.tier),
			suiteVersion: suiteVersion(),
		});
		// Conformance sessions are ephemeral: revoke the OAuth tokens once
		// the run is done, best-effort.
		if (oauthOperator) await oauthOperator.signOut();
		if (values.report) {
			writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
		}
		process.stdout.write(
			values.json
				? `${JSON.stringify(report, null, 2)}\n`
				: `${renderReport(report)}\n`,
		);
		// Gate on must-tier failures AND must-tier errors; should/info never
		// fail the run. A must check that errored (an unreachable, hung or
		// malformed target) must exit non-zero too — otherwise a target
		// whose XRPC surface is down but whose did.json resolves would pass
		// CI green.
		return report.summary.mustFail > 0 || report.summary.mustError > 0 ? 1 : 0;
	}

	process.stderr.write("usage: space-conformance <run|coverage> [options]\n");
	return 2;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = 1;
	},
);
