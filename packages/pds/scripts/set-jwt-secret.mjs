#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";

async function main() {
	p.intro("Set JWT Secret");

	const secret = randomBytes(32).toString("base64");

	const s = p.spinner();
	s.start("Setting JWT_SECRET via wrangler");

	await new Promise((resolve, reject) => {
		const wrangler = spawn(
			"npx",
			["wrangler", "secret", "put", "JWT_SECRET"],
			{
				stdio: ["pipe", "ignore", "pipe"],
			},
		);

		let stderr = "";
		wrangler.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		wrangler.stdin.write(secret);
		wrangler.stdin.end();

		wrangler.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `wrangler exited with code ${code}`));
			}
		});
	});

	s.stop("JWT_SECRET set");

	p.outro("JWT secret configured successfully!");
}

main().catch((err) => {
	p.cancel(err.message);
	process.exit(1);
});
