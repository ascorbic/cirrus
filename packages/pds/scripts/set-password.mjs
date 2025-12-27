#!/usr/bin/env node

import { spawn } from "node:child_process";
import { hash } from "bcryptjs";
import * as p from "@clack/prompts";

async function main() {
	p.intro("Set PDS Login Password");

	const password = await p.password({
		message: "Enter password",
		validate: (value) => {
			if (value.length < 8) return "Password must be at least 8 characters";
		},
	});

	if (p.isCancel(password)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	const confirm = await p.password({
		message: "Confirm password",
	});

	if (p.isCancel(confirm)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	if (password !== confirm) {
		p.cancel("Passwords do not match");
		process.exit(1);
	}

	const s = p.spinner();
	s.start("Hashing password");

	const passwordHash = await hash(password, 10);

	s.message("Setting PASSWORD_HASH secret via wrangler");

	await new Promise((resolve, reject) => {
		const wrangler = spawn(
			"npx",
			["wrangler", "secret", "put", "PASSWORD_HASH"],
			{
				stdio: ["pipe", "ignore", "pipe"],
			},
		);

		let stderr = "";
		wrangler.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		wrangler.stdin.write(passwordHash);
		wrangler.stdin.end();

		wrangler.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `wrangler exited with code ${code}`));
			}
		});
	});

	s.stop("PASSWORD_HASH secret set");

	p.outro("Password configured successfully!");
}

main().catch((err) => {
	p.cancel(err.message);
	process.exit(1);
});
