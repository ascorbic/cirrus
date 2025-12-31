import type { ChildProcess } from "node:child_process";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

let serverProcess: ChildProcess;
let tempDir: string;

function runCommand(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => (stdout += data));
		proc.stderr.on("data", (data) => (stderr += data));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

export async function setup() {
	// Create temp directory
	tempDir = await mkdtemp(join(tmpdir(), "pds-e2e-"));
	console.log(`Creating e2e test fixture in: ${tempDir}`);

	// Copy fixture to temp directory
	const fixturePath = resolve(__dirname, "fixture");
	await cp(fixturePath, tempDir, { recursive: true });

	// Update package.json with actual path to pds package
	const pdsPackagePath = resolve(__dirname, "..");
	const packageJsonPath = join(tempDir, "package.json");
	const packageJson = await readFile(packageJsonPath, "utf-8");
	await writeFile(
		packageJsonPath,
		packageJson.replace("{{PDS_PACKAGE_PATH}}", `file:${pdsPackagePath}`),
	);

	// Install dependencies
	console.log("Installing dependencies in temp fixture...");
	const installResult = await runCommand("npm", ["install"], tempDir);
	if (installResult.code !== 0) {
		console.error("npm install failed:", installResult.stderr);
		throw new Error(`npm install failed with code ${installResult.code}`);
	}
	console.log("Dependencies installed");

	// Start Vite dev server
	const port = await startViteServer(tempDir);

	console.log(`E2E test server started on port ${port}`);

	(globalThis as Record<string, unknown>).__e2e_port__ = port;
	(globalThis as Record<string, unknown>).__e2e_tempDir__ = tempDir;
}

function startViteServer(cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const proc = spawn("npm", ["run", "dev"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		serverProcess = proc;

		let output = "";
		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error(`Vite server startup timeout. Output: ${output}`));
		}, 60000);

		proc.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
			// Look for the local URL in Vite's output
			// e.g., "Local:   http://localhost:5173/"
			const match = output.match(/Local:\s+http:\/\/localhost:(\d+)/);
			if (match?.[1]) {
				clearTimeout(timeout);
				resolve(parseInt(match[1], 10));
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				clearTimeout(timeout);
				reject(new Error(`Vite exited with code ${code}. Output: ${output}`));
			}
		});
	});
}

export async function teardown() {
	if (serverProcess) {
		serverProcess.kill();
		console.log("E2E test server stopped");
	}

	// Clean up temp directory
	if (tempDir) {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
