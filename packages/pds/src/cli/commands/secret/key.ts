import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Secp256k1Keypair } from "@atproto/crypto";
import { setWranglerSecrets } from "../../utils/wrangler.js";
import { appendDevVars } from "../../utils/dotenv.js";

export default defineCommand({
	meta: {
		name: "key",
		description: "Generate and set signing keypair",
	},
	args: {
		local: {
			type: "boolean",
			alias: "l",
			description: "Write to .dev.vars instead of wrangler",
		},
	},
	async run({ args }) {
		p.intro("Generate Signing Keypair");

		const spin = p.spinner();
		spin.start("Generating secp256k1 keypair");

		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const privateKeyBytes = await keypair.export();
		const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex");
		const publicKeyMultibase = keypair.did().replace("did:key:", "");

		const secrets = {
			SIGNING_KEY: privateKeyHex,
			SIGNING_KEY_PUBLIC: publicKeyMultibase,
		};

		if (args.local) {
			appendDevVars(secrets);
			spin.stop("Keys written to .dev.vars");
		} else {
			spin.message("Setting keys via wrangler");
			await setWranglerSecrets(secrets);
			spin.stop("Signing keys set");
		}

		p.note(`did:key:${publicKeyMultibase}`);
		p.outro("Signing keypair configured!");
	},
});
