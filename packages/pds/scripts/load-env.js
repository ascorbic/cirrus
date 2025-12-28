#!/usr/bin/env node
/**
 * Load environment variables from .dev.vars and run a command.
 *
 * Usage:
 *   node scripts/load-env.js node scripts/test-firehose.js
 */

import { readFileSync } from "fs";
import { spawn } from "child_process";

try {
	const vars = readFileSync(".dev.vars", "utf-8");
	const lines = vars.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#")) {
			const [key, ...valueParts] = trimmed.split("=");
			const value = valueParts.join("=");
			process.env[key] = value;
		}
	}
} catch (err) {
	console.error("Warning: Could not load .dev.vars file");
	console.error(
		"Make sure you have a .dev.vars file with DID, AUTH_TOKEN, etc.",
	);
}

// Run the command with loaded env vars
const args = process.argv.slice(2);
if (args.length === 0) {
	console.error("Usage: node scripts/load-env.js <command> [args...]");
	process.exit(1);
}

const child = spawn(args[0], args.slice(1), {
	stdio: "inherit",
	env: process.env,
	shell: true,
});

child.on("exit", (code) => {
	process.exit(code || 0);
});
