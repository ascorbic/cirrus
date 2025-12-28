/**
 * Signing key generation command
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Secp256k1Keypair } from "@atproto/crypto";
import { setSecret, setVar } from "../../utils/wrangler.js";
import { setDevVar } from "../../utils/dotenv.js";

export const keyCommand = defineCommand({
	meta: {
		name: "key",
		description: "Generate and set signing keypair",
	},
	args: {
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets/config",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("Generate Signing Keypair");

		const spinner = p.spinner();
		spinner.start("Generating secp256k1 keypair...");

		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const privateKeyJwk = await keypair.export();
		const publicKeyMultibase = keypair.did().replace("did:key:", "");

		spinner.stop("Keypair generated");

		const privateKeyJson = JSON.stringify(privateKeyJwk);

		if (args.local) {
			setDevVar("SIGNING_KEY", privateKeyJson);
			setDevVar("SIGNING_KEY_PUBLIC", publicKeyMultibase);
			p.outro("SIGNING_KEY and SIGNING_KEY_PUBLIC written to .dev.vars");
		} else {
			spinner.start("Setting SIGNING_KEY via wrangler secret...");
			try {
				await setSecret("SIGNING_KEY", privateKeyJson);
				spinner.stop("SIGNING_KEY set");

				spinner.start("Setting SIGNING_KEY_PUBLIC in wrangler.jsonc...");
				setVar("SIGNING_KEY_PUBLIC", publicKeyMultibase);
				spinner.stop("SIGNING_KEY_PUBLIC set");

				p.outro("Done!");
			} catch (error) {
				spinner.stop("Failed");
				p.log.error(String(error));
				process.exit(1);
			}
		}

		p.log.info("Public key (for DID document): " + publicKeyMultibase);
	},
});
