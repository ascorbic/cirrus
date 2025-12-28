import { spawn } from "node:child_process";

export async function setWranglerSecret(
	name: string,
	value: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const wrangler = spawn("npx", ["wrangler", "secret", "put", name], {
			stdio: ["pipe", "ignore", "pipe"],
		});

		let stderr = "";
		wrangler.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		wrangler.stdin.write(value);
		wrangler.stdin.end();

		wrangler.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `wrangler exited with code ${code}`));
			}
		});
	});
}

export async function setWranglerSecrets(
	secrets: Record<string, string>,
): Promise<void> {
	for (const [name, value] of Object.entries(secrets)) {
		await setWranglerSecret(name, value);
	}
}
