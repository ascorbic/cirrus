/**
 * .dev.vars file utilities for local development
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEV_VARS_FILE = ".dev.vars";

/**
 * Parse a .dev.vars file into a record
 */
export function readDevVars(
	dir: string = process.cwd(),
): Record<string, string> {
	const filePath = resolve(dir, DEV_VARS_FILE);

	if (!existsSync(filePath)) {
		return {};
	}

	const content = readFileSync(filePath, "utf-8");
	const vars: Record<string, string> = {};

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();

		// Remove quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		vars[key] = value;
	}

	return vars;
}

/**
 * Quote a value if it contains special characters
 */
function quoteValue(value: string): string {
	if (value.includes(" ") || value.includes('"') || value.includes("'")) {
		// Escape double quotes and wrap in double quotes
		return '"' + value.replace(/"/g, '\\"') + '"';
	}
	return value;
}

/**
 * Write vars to .dev.vars file, preserving comments and order
 */
export function writeDevVars(
	vars: Record<string, string>,
	dir: string = process.cwd(),
): void {
	const filePath = resolve(dir, DEV_VARS_FILE);

	// Read existing content to preserve comments
	let existingLines: string[] = [];

	if (existsSync(filePath)) {
		existingLines = readFileSync(filePath, "utf-8").split("\n");
	}

	// Update existing lines
	const outputLines: string[] = [];
	const updatedKeys = new Set<string>();

	for (const line of existingLines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			outputLines.push(line);
			continue;
		}

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) {
			outputLines.push(line);
			continue;
		}

		const key = trimmed.slice(0, eqIndex).trim();
		if (key in vars) {
			outputLines.push(key + "=" + quoteValue(vars[key]));
			updatedKeys.add(key);
		} else {
			outputLines.push(line);
		}
	}

	// Add new keys
	for (const [key, value] of Object.entries(vars)) {
		if (!updatedKeys.has(key)) {
			outputLines.push(key + "=" + quoteValue(value));
		}
	}

	// Ensure trailing newline
	const content = outputLines.join("\n").trimEnd() + "\n";
	writeFileSync(filePath, content);
}

/**
 * Set a single var in .dev.vars
 */
export function setDevVar(
	key: string,
	value: string,
	dir: string = process.cwd(),
): void {
	const vars = readDevVars(dir);
	vars[key] = value;
	writeDevVars(vars, dir);
}
