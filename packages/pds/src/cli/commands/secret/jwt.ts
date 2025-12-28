import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { setWranglerSecret } from "../../utils/wrangler.js";
import { appendDevVar } from "../../utils/dotenv.js";

export default defineCommand({
	meta: {
		name: "jwt",
		description: "Generate and set JWT secret",
	},
	args: {
		local: {
			type: "boolean",
			alias: "l",
			description: "Write to .dev.vars instead of wrangler",
		},
	},
	async run({ args }) {
		p.intro("Set JWT Secret");

		const secret = randomBytes(32).toString("base64");
		const spin = p.spinner();

		if (args.local) {
			appendDevVar("JWT_SECRET", secret);
			p.note("JWT_SECRET written to .dev.vars");
		} else {
			spin.start("Setting JWT_SECRET via wrangler");
			await setWranglerSecret("JWT_SECRET", secret);
			spin.stop("JWT_SECRET set");
		}

		p.outro("JWT secret configured!");
	},
});
