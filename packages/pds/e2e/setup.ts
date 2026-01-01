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
	console.log("=== E2E Setup Starting ===");
	const startTime = Date.now();

	// Log environment info
	console.log(`Node version: ${process.version}`);
	console.log(`Platform: ${process.platform}`);
	console.log(`Temp dir: ${tmpdir()}`);

	// Create temp directory
	tempDir = await mkdtemp(join(tmpdir(), "pds-e2e-"));
	console.log(`Created temp directory: ${tempDir}`);

	// Copy fixture to temp directory
	const fixturePath = resolve(__dirname, "fixture");
	console.log(`Copying fixture from: ${fixturePath}`);
	console.log(`Copying fixture to: ${tempDir}`);
	await cp(fixturePath, tempDir, { recursive: true });
	console.log(`Fixture copied (${Date.now() - startTime}ms elapsed)`);

	// Update package.json with actual path to pds package
	const pdsPackagePath = resolve(__dirname, "..");
	const packageJsonPath = join(tempDir, "package.json");
	console.log(`PDS package path: ${pdsPackagePath}`);
	console.log(`Updating package.json at: ${packageJsonPath}`);

	const packageJson = await readFile(packageJsonPath, "utf-8");
	const updatedPackageJson = packageJson.replace(
		"{{PDS_PACKAGE_PATH}}",
		`file:${pdsPackagePath}`,
	);
	await writeFile(packageJsonPath, updatedPackageJson);
	console.log(`Package.json updated (${Date.now() - startTime}ms elapsed)`);

	// Install dependencies
	console.log("=== Installing dependencies ===");
	console.log(`Running: npm install in ${tempDir}`);
	const installStart = Date.now();
	const installResult = await runCommand("npm", ["install"], tempDir);

	console.log(`npm install completed in ${Date.now() - installStart}ms`);
	console.log(`Exit code: ${installResult.code}`);

	if (installResult.stdout) {
		console.log("=== npm install stdout ===");
		console.log(installResult.stdout);
	}

	if (installResult.stderr) {
		console.log("=== npm install stderr ===");
		console.log(installResult.stderr);
	}

	if (installResult.code !== 0) {
		console.error("npm install failed with code:", installResult.code);
		throw new Error(`npm install failed with code ${installResult.code}`);
	}
	console.log(`Dependencies installed (${Date.now() - startTime}ms total elapsed)`);

	// Start Vite dev server
	console.log("=== Starting Vite dev server ===");
	const viteStart = Date.now();
	const port = await startViteServer(tempDir);
	console.log(`Vite server started in ${Date.now() - viteStart}ms`);

	console.log(`E2E test server running on port ${port}`);
	console.log(`Total setup time: ${Date.now() - startTime}ms`);

	(globalThis as Record<string, unknown>).__e2e_port__ = port;
	(globalThis as Record<string, unknown>).__e2e_tempDir__ = tempDir;
}

function startViteServer(cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		console.log(`Running: npm run dev in ${cwd}`);
		const proc = spawn("npm", ["run", "dev"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		serverProcess = proc;

		let output = "";
		const startTime = Date.now();
		const timeout = setTimeout(() => {
			console.error(`Vite server startup timeout after 60s`);
			console.error(`Full output:\n${output}`);
			proc.kill();
			reject(new Error(`Vite server startup timeout. Output: ${output}`));
		}, 60000);

		proc.stdout?.on("data", (data: Buffer) => {
			const chunk = data.toString();
			output += chunk;
			// Log Vite output incrementally
			process.stdout.write(`[Vite stdout] ${chunk}`);

			// Look for the local URL in Vite's output
			// e.g., "  ➜  Local:   http://localhost:5173/"
			// Strip ANSI escape codes before matching (bold, colors, etc)
			const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
			const match = cleanOutput.match(/localhost:(\d+)/);
			if (match?.[1]) {
				console.log(
					`Detected Vite server on port ${match[1]} (${Date.now() - startTime}ms)`,
				);
				clearTimeout(timeout);
				resolve(parseInt(match[1], 10));
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const chunk = data.toString();
			output += chunk;
			// Log Vite errors incrementally
			process.stderr.write(`[Vite stderr] ${chunk}`);
		});

		proc.on("error", (err) => {
			console.error(`Vite process error:`, err);
			clearTimeout(timeout);
			reject(err);
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				console.error(`Vite exited with code ${code}`);
				console.error(`Full output:\n${output}`);
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
