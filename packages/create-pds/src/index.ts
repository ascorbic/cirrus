#!/usr/bin/env node
/**
 * create-pds - Create a new AT Protocol PDS on Cloudflare Workers
 */
import { defineCommand, runMain } from "citty";
import * as p from "@clack/prompts";
import { spawn } from "node:child_process";
import { cp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

function detectPackageManager(): PackageManager {
	const userAgent = process.env.npm_config_user_agent || "";
	if (userAgent.startsWith("yarn")) return "yarn";
	if (userAgent.startsWith("pnpm")) return "pnpm";
	if (userAgent.startsWith("bun")) return "bun";
	return "npm";
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	options: { silent?: boolean } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: options.silent ? "pipe" : "inherit",
			shell: process.platform === "win32",
		});

		let output = "";
		if (options.silent) {
			child.stdout?.on("data", (data) => {
				output += data.toString();
			});
			child.stderr?.on("data", (data) => {
				output += data.toString();
			});
		}

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				if (options.silent && output) {
					console.error(output);
				}
				reject(
					new Error(`${command} ${args.join(" ")} failed with code ${code}`),
				);
			}
		});

		child.on("error", reject);
	});
}

async function copyTemplateDir(src: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		let destName = entry.name;

		// Rename dotfiles (npm strips them from packages)
		if (destName === "gitignore") destName = ".gitignore";
		else if (destName === "env.example") destName = ".env.example";
		// Handle .tmpl files
		else if (destName.endsWith(".tmpl")) destName = destName.slice(0, -5);

		const destPath = join(dest, destName);

		if (entry.isDirectory()) {
			await copyTemplateDir(srcPath, destPath);
		} else {
			await cp(srcPath, destPath);
		}
	}
}

async function replaceInFile(
	filePath: string,
	replacements: Record<string, string>,
): Promise<void> {
	let content = await readFile(filePath, "utf-8");
	for (const [key, value] of Object.entries(replacements)) {
		content = content.replaceAll(`{{${key}}}`, value);
	}
	await writeFile(filePath, content);
}

async function getLatestPdsVersion(): Promise<string> {
	try {
		const response = await fetch(
			"https://registry.npmjs.org/@ascorbic/pds/latest",
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch: ${response.status}`);
		}
		const data = (await response.json()) as { version: string };
		return `^${data.version}`;
	} catch {
		// Fallback to a known version if fetch fails
		return "^0.2.0";
	}
}

const main = defineCommand({
	meta: {
		name: "create-pds",
		version: "0.0.0",
		description: "Create a new AT Protocol PDS on Cloudflare Workers",
	},
	args: {
		name: {
			type: "positional",
			description: "Folder name",
			required: false,
		},
		"package-manager": {
			type: "string",
			alias: "pm",
			description: "Package manager to use (npm, yarn, pnpm, bun)",
		},
		"skip-install": {
			type: "boolean",
			description: "Skip installing dependencies",
			default: false,
		},
		"skip-git": {
			type: "boolean",
			description: "Skip git initialization",
			default: false,
		},
		"skip-init": {
			type: "boolean",
			description: "Skip running pds init",
			default: false,
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Accept all defaults (non-interactive mode)",
			default: false,
		},
	},
	async run({ args }) {
		const nonInteractive = args.yes || !process.stdout.isTTY;
		p.intro("🦋 Create PDS");

		p.log.info("Let's build your new home in the Atmosphere!");
		p.log.warn(
			"This is experimental software. Don't migrate your main account yet.",
		);

		if (!nonInteractive) {
			p.log.message("Tip: Use --yes to skip prompts");
		}

		// Get folder name
		let projectName = args.name;
		if (!projectName) {
			if (nonInteractive) {
				projectName = "my-pds";
			} else {
				const result = await p.text({
					message: "Folder name:",
					placeholder: "my-pds",
					defaultValue: "my-pds",
				});
				if (p.isCancel(result)) {
					p.cancel("Cancelled");
					process.exit(0);
				}
				projectName = result || "my-pds";
			}
		}

		const targetDir = join(process.cwd(), projectName);

		// Check if directory exists
		if (existsSync(targetDir)) {
			if (nonInteractive) {
				p.log.error(`Directory ${projectName} already exists`);
				process.exit(1);
			}
			const overwrite = await p.confirm({
				message: `Directory ${projectName} already exists. Overwrite?`,
				initialValue: false,
			});
			if (p.isCancel(overwrite) || !overwrite) {
				p.cancel("Cancelled");
				process.exit(0);
			}
		}

		// Get package manager
		const detectedPm = detectPackageManager();
		let pm: PackageManager =
			(args["package-manager"] as PackageManager) || detectedPm;

		if (!args["package-manager"] && !nonInteractive) {
			const pmResult = await p.select({
				message: "Package manager:",
				initialValue: detectedPm,
				options: [
					{ value: "pnpm", label: "pnpm" },
					{ value: "npm", label: "npm" },
					{ value: "yarn", label: "yarn" },
					{ value: "bun", label: "bun" },
				],
			});
			if (p.isCancel(pmResult)) {
				p.cancel("Cancelled");
				process.exit(0);
			}
			pm = pmResult as PackageManager;
		}

		// Ask about git
		let initGit = !args["skip-git"];
		if (!args["skip-git"] && !nonInteractive) {
			const gitResult = await p.confirm({
				message: "Initialize git repository?",
				initialValue: true,
			});
			if (p.isCancel(gitResult)) {
				p.cancel("Cancelled");
				process.exit(0);
			}
			initGit = gitResult;
		}

		// Copy template
		const spinner = p.spinner();
		spinner.start("Fetching latest @ascorbic/pds version...");
		const pdsVersion = await getLatestPdsVersion();
		spinner.stop(`Using @ascorbic/pds ${pdsVersion}`);

		spinner.start("Copying template...");

		const templateDir = join(__dirname, "..", "templates", "pds-worker");
		await copyTemplateDir(templateDir, targetDir);

		// Replace placeholders in package.json
		await replaceInFile(join(targetDir, "package.json"), {
			name: projectName,
			pdsVersion,
		});

		spinner.stop("Template copied");

		// Initialize git
		if (initGit) {
			spinner.start("Initializing git...");
			try {
				await runCommand("git", ["init"], targetDir, { silent: true });
				spinner.stop("Git initialized");
			} catch {
				spinner.stop("Failed to initialize git");
			}
		}

		// Install dependencies
		if (!args["skip-install"]) {
			spinner.start(`Installing dependencies with ${pm}...`);
			try {
				await runCommand(pm, ["install"], targetDir, { silent: true });
				spinner.stop("Dependencies installed");
			} catch {
				spinner.stop("Failed to install dependencies");
				p.log.warning("You can install dependencies manually later");
			}
		}

		// Initial commit (after install so lockfile is included)
		if (initGit) {
			try {
				await runCommand("git", ["add", "."], targetDir, { silent: true });
				await runCommand("git", ["commit", "-m", "Initial commit"], targetDir, {
					silent: true,
				});
			} catch {
				// Ignore commit errors
			}
		}

		// Run pds init
		if (!args["skip-init"] && !args["skip-install"]) {
			p.log.info("Now let's set up your account...");

			try {
				const pdsArgs = ["run", "pds", "init"];

				await runCommand(pm, pdsArgs, targetDir);

				// Commit the changes from pds init
				if (initGit) {
					await runCommand("git", ["add", "."], targetDir, { silent: true });
					await runCommand(
						"git",
						["commit", "-m", "Configure PDS"],
						targetDir,
						{ silent: true },
					);
				}
			} catch {
				p.log.warning("Failed to run pds init. You can run it manually later:");
				p.log.info(
					`  cd ${projectName} && ${pm}${pm === "npm" ? "run" : ""} pds init`,
				);
			}
		}

		p.note(
			[
				`cd ${projectName}`,
				`${pm} dev`,
				"",
				"Your PDS will be running at http://localhost:5173",
			].join("\n"),
			"Next Steps",
		);

		p.outro("Welcome to the Atmosphere! 🦋");
	},
});

runMain(main);
