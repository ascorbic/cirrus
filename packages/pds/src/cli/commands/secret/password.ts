import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { hash } from "bcryptjs";
import { setWranglerSecret } from "../../utils/wrangler.js";
import { appendDevVar } from "../../utils/dotenv.js";

export default defineCommand({
	meta: {
		name: "password",
		description: "Set password hash for app login",
	},
	args: {
		local: {
			type: "boolean",
			alias: "l",
			description: "Write to .dev.vars instead of wrangler",
		},
	},
	async run({ args }) {
		p.intro("Set PDS Login Password");

		const password = await p.password({
			message: "Enter password",
			validate: (v) => {
				if (v.length < 8) return "Password must be at least 8 characters";
			},
		});
		if (p.isCancel(password)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		const confirm = await p.password({ message: "Confirm password" });
		if (p.isCancel(confirm)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		if (password !== confirm) {
			p.cancel("Passwords do not match");
			process.exit(1);
		}

		const spin = p.spinner();
		spin.start("Hashing password");
		const passwordHash = await hash(password, 10);

		if (args.local) {
			appendDevVar("PASSWORD_HASH", passwordHash);
			spin.stop("PASSWORD_HASH written to .dev.vars");
		} else {
			spin.message("Setting PASSWORD_HASH via wrangler");
			await setWranglerSecret("PASSWORD_HASH", passwordHash);
			spin.stop("PASSWORD_HASH set");
		}

		p.outro("Password configured!");
	},
});
