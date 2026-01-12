/**
 * Interactive PDS setup wizard
 */
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
	setVars,
	getVars,
	getWorkerName,
	setWorkerName,
	setAccountId,
	setCustomDomains,
	detectCloudflareAccounts,
	listSecrets,
	runWrangler,
	type SecretName,
} from "../utils/wrangler.js";
import {
	promptText,
	promptConfirm,
	promptSelect,
	detectPackageManager,
	formatCommand,
	copyToClipboard,
	saveKeyBackup,
	is1PasswordAvailable,
	saveTo1Password,
	runCommand,
} from "../utils/cli-helpers.js";

/**
 * Slugify a handle to create a worker name
 * e.g., "example.com" -> "example-com-pds"
 */
function slugifyHandle(handle: string): string {
	return (
		handle
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") + "-pds"
	);
}

const defaultWorkerName = "my-pds";

/**
 * Prompt for worker name with validation
 */
async function promptWorkerName(
	handle: string,
	currentWorkerName: string | undefined,
): Promise<string> {
	// Use current worker name if it exists and is not the default
	const placeholder =
		currentWorkerName && currentWorkerName !== defaultWorkerName
			? currentWorkerName
			: // Otherwise, generate from handle
				slugifyHandle(handle);
	return promptText({
		message: "Cloudflare Worker name:",
		placeholder,
		initialValue: placeholder,
		validate: (v) => {
			if (!v) return "Worker name is required";
			if (!/^[a-z0-9-]+$/.test(v))
				return "Worker name can only contain lowercase letters, numbers, and hyphens";
			return undefined;
		},
	});
}
import { readDevVars } from "../utils/dotenv.js";
import {
	generateSigningKeypair,
	derivePublicKey,
	generateAuthToken,
	generateJwtSecret,
	hashPassword,
	promptPassword,
	setSecretValue,
} from "../utils/secrets.js";

import { resolveHandleToDid } from "../utils/handle-resolver.js";
import { DidResolver } from "../../did-resolver.js";

/**
 * Ensure a Cloudflare account_id is configured.
 * If multiple accounts detected, prompts user to select one.
 */
async function ensureAccountConfigured(): Promise<void> {
	const spinner = p.spinner();
	spinner.start("Checking Cloudflare account...");

	const accounts = await detectCloudflareAccounts();

	if (accounts === null) {
		spinner.stop("Cloudflare account configured");
		return;
	}

	spinner.stop(`Found ${accounts.length} Cloudflare accounts`);

	const selectedId = await promptSelect({
		message: "Select your Cloudflare account:",
		options: accounts.map((acc) => ({
			value: acc.id,
			label: acc.name,
			hint: acc.id.slice(0, 8) + "...",
		})),
	});

	setAccountId(selectedId);
	const selectedName = accounts.find((a) => a.id === selectedId)?.name;
	p.log.success(`Account "${selectedName}" saved to wrangler.jsonc`);
}

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description: "Interactive PDS setup wizard",
	},
	args: {
		production: {
			type: "boolean",
			description: "Deploy secrets to Cloudflare?",
			default: false,
		},
	},
	async run({ args }) {
		const pm = detectPackageManager();

		p.intro("🦋 PDS Setup");

		const isProduction = args.production;
		if (isProduction) {
			p.log.info("Production mode: secrets will be deployed to Cloudflare");
		}
		p.log.info("Let's set up your new home in the Atmosphere!");

		// Get current config from both sources
		const wranglerVars = getVars();
		const devVars = readDevVars();

		// Check for "freshly cloned" case: secrets exist in CF but not locally
		// This is dangerous because we can't retrieve the values - generating new ones would break the identity
		let cfSecrets: string[] = [];
		try {
			cfSecrets = await listSecrets();
		} catch {
			// Ignore errors - probably not logged in or no worker yet
		}

		if (cfSecrets.includes("SIGNING_KEY") && !devVars.SIGNING_KEY) {
			p.log.error("⚠️  Signing key exists in Cloudflare but not locally!");
			p.note(
				[
					"Your PDS has a signing key deployed to Cloudflare, but you don't have",
					"a local copy in .dev.vars. This usually happens after cloning to a new",
					"machine without restoring your key backup.",
					"",
					"Cloudflare secrets CANNOT be retrieved once set.",
					"",
					"To continue, you need to:",
					"  1. Restore your signing key from your backup (password manager, etc.)",
					"  2. Add it to .dev.vars as: SIGNING_KEY=your-key-here",
					"  3. Run 'pds init' again",
					"",
					"If you've lost your key backup, your options are limited:",
					"  • For did:web: Generate a new key (old signatures become unverifiable)",
					"  • For did:plc: Use a recovery key if you have one",
					"",
					"See: https://github.com/ascorbic/cirrus#key-recovery",
				].join("\n"),
				"Key Recovery Required",
			);
			p.outro("Initialization cancelled.");
			process.exit(1);
		}

		// Use wrangler vars as primary source for public config
		const currentVars = { ...devVars, ...wranglerVars };

		// Ask if migrating an existing account
		const isMigrating = await promptConfirm({
			message: "Are you migrating an existing Bluesky/ATProto account?",
			initialValue: false,
		});

		let did: string;
		let handle: string;
		let hostname: string;
		let workerName: string;
		let initialActive: string;

		const currentWorkerName = getWorkerName();

		if (isMigrating) {
			p.log.info("Time to pack your bags! 🧳");
			p.log.info(
				"Your new account will be inactive until you're ready to go live.",
			);

			// Fallback hosted domains - will be updated from source PDS if possible
			let hostedDomains = [".bsky.social", ".bsky.network", ".bsky.team"];
			const isHostedHandle = (h: string | null) =>
				hostedDomains.some((domain) => h?.endsWith(domain));

			// Loop to allow retry on failed handle resolution (max 3 attempts)
			let resolvedDid: string | null = null;
			let existingHandle: string | null = null;
			let attempts = 0;
			const MAX_ATTEMPTS = 3;

			while (!resolvedDid && attempts < MAX_ATTEMPTS) {
				attempts++;
				// Get current handle to look up DID
				const currentHandle = await promptText({
					message: "Your current Bluesky/ATProto handle:",
					placeholder: "example.bsky.social",
					validate: (v) => (!v ? "Handle is required" : undefined),
				});
				existingHandle = currentHandle;

				// Resolve handle to DID
				const spinner = p.spinner();
				spinner.start("Finding you in the Atmosphere...");
				resolvedDid = await resolveHandleToDid(currentHandle as string);

				if (!resolvedDid) {
					spinner.stop("Not found");
					p.log.error(`Failed to resolve handle "${currentHandle}"`);

					const action = await promptSelect({
						message: "What would you like to do?",
						options: [
							{ value: "retry" as const, label: "Try a different handle" },
							{ value: "manual" as const, label: "Enter DID manually" },
						],
					});

					if (action === "manual") {
						resolvedDid = await promptText({
							message: "Enter your DID:",
							placeholder: "did:plc:...",
							validate: (v) => {
								if (!v) return "DID is required";
								if (!v.startsWith("did:")) return "DID must start with did:";
								return undefined;
							},
						});
					}
					// If action === "retry", loop continues with fresh handle prompt
				} else {
					// Try to get hosted domains from source PDS
					try {
						const didResolver = new DidResolver();
						const didDoc = await didResolver.resolve(resolvedDid);
						const pdsService = didDoc?.service?.find(
							(s) =>
								s.type === "AtprotoPersonalDataServer" ||
								s.id === "#atproto_pds",
						);
						if (pdsService?.serviceEndpoint) {
							const describeRes = await fetch(
								`${pdsService.serviceEndpoint}/xrpc/com.atproto.server.describeServer`,
							);
							if (describeRes.ok) {
								const desc = (await describeRes.json()) as {
									availableUserDomains?: string[];
								};
								if (desc.availableUserDomains?.length) {
									hostedDomains = desc.availableUserDomains.map((d) =>
										d.startsWith(".") ? d : `.${d}`,
									);
								}
							}
						}
					} catch {
						// Ignore errors, use fallback domains
					}
					spinner.stop(`Found you! ${resolvedDid}`);
					if (isHostedHandle(existingHandle)) {
						// Show the actual hosted domain they're on
						const theirDomain = hostedDomains.find((d) =>
							existingHandle?.endsWith(d),
						);
						const domainExample = theirDomain
							? `*${theirDomain}`
							: "*.bsky.social";
						p.log.warn(
							`You'll need a custom domain for your new handle (not ${domainExample}). You can set this up after transferring your data.`,
						);
					}
					if (attempts >= MAX_ATTEMPTS) {
						p.log.error("Unable to resolve handle after 3 attempts.");
						p.log.info("");
						p.log.info("You can:");
						p.log.info("  1. Double-check your handle spelling");
						p.log.info("  2. Provide your DID directly if you know it");
						p.log.info("  3. Run 'pds init' again when ready");
						p.outro("Initialization cancelled.");
						process.exit(1);
					}
				}
			}
			did = resolvedDid!;

			// Prompt for new handle first (right after the warning about hosted handles)
			const defaultHandle =
				existingHandle && !isHostedHandle(existingHandle)
					? existingHandle
					: currentVars.HANDLE || "";

			handle = await promptText({
				message: "New account handle (must be a domain you control):",
				placeholder: "example.com",
				initialValue: defaultHandle,
				validate: (v) => {
					if (!v) return "Handle is required";
					if (isHostedHandle(v)) {
						return "You need a custom domain - hosted handles like *.bsky.social won't work";
					}
					return undefined;
				},
			});

			// Prompt for PDS hostname - default to handle if it looks like a good PDS domain
			hostname = await promptText({
				message: "Domain where you'll deploy your PDS:",
				placeholder: handle,
				initialValue: currentVars.PDS_HOSTNAME || handle,
				validate: (v) => (!v ? "Hostname is required" : undefined),
			});

			workerName = await promptWorkerName(handle, currentWorkerName);

			// Set to deactivated initially for migration
			initialActive = "false";

			// Ensure Cloudflare account is configured before any wrangler operations
			await ensureAccountConfigured();
		} else {
			// New account flow
			p.log.info("A fresh start in the Atmosphere! ✨");

			// Prompt for hostname
			hostname = await promptText({
				message: "Domain where you'll deploy your PDS:",
				placeholder: "pds.example.com",
				initialValue: currentVars.PDS_HOSTNAME || "",
				validate: (v) => (!v ? "Hostname is required" : undefined),
			});

			// Prompt for handle - default to hostname for simplicity
			handle = await promptText({
				message: "Account handle:",
				placeholder: hostname,
				initialValue: currentVars.HANDLE || hostname,
				validate: (v) => (!v ? "Handle is required" : undefined),
			});

			// Prompt for DID
			const didDefault = "did:web:" + hostname;
			did = await promptText({
				message: "Account DID:",
				placeholder: didDefault,
				initialValue: currentVars.DID || didDefault,
				validate: (v) => {
					if (!v) {
						return "DID is required";
					}
					if (!v.startsWith("did:")) return "DID must start with 'did:'";
					return undefined;
				},
			});

			workerName = await promptWorkerName(handle, currentWorkerName);

			// Active by default for new accounts
			initialActive = "true";

			// Ensure Cloudflare account is configured before any wrangler operations
			await ensureAccountConfigured();

			// Show different notes based on whether handle matches hostname
			if (handle === hostname) {
				p.note(
					[
						"Your handle matches your PDS hostname, so your PDS will",
						"automatically handle domain verification for you!",
						"",
						"For did:web, your PDS serves the DID document at:",
						`  https://${hostname}/.well-known/did.json`,
						"",
						"For handle verification, it serves:",
						`  https://${hostname}/.well-known/atproto-did`,
						"",
						"No additional DNS or hosting setup needed. Easy! 🎉",
					].join("\n"),
					"Identity Setup 🪪",
				);
			} else {
				p.note(
					[
						"For did:web, your PDS will serve the DID document at:",
						`  https://${hostname}/.well-known/did.json`,
						"",
						"To verify your handle, create a DNS TXT record:",
						`  _atproto.${handle} TXT "did=${did}"`,
						"",
						"Or serve a file at:",
						`  https://${handle}/.well-known/atproto-did`,
						`  containing: ${did}`,
					].join("\n"),
					"Identity Setup 🪪",
				);
			}
		}

		// Prompt for data location (skip if already configured)
		let dataLocation: string;
		if (currentVars.DATA_LOCATION) {
			dataLocation = currentVars.DATA_LOCATION;
		} else {
			dataLocation = await promptSelect({
				message: "Where should your data be stored?",
				options: [
					{
						value: "auto" as const,
						label: "Auto (Recommended)",
						hint: "Cloudflare chooses optimal location",
					},
					{
						value: "eu" as const,
						label: "European Union",
						hint: "GDPR jurisdiction guarantee",
					},
					{
						value: "wnam" as const,
						label: "Western North America",
						hint: "Location hint",
					},
					{
						value: "enam" as const,
						label: "Eastern North America",
						hint: "Location hint",
					},
					{
						value: "apac" as const,
						label: "Asia-Pacific",
						hint: "Location hint",
					},
					{
						value: "oc" as const,
						label: "Oceania",
						hint: "Location hint",
					},
				],
			});

			if (dataLocation && dataLocation !== "auto") {
				p.log.warn("⚠️  Data location cannot be changed after deployment!");
				p.note(
					[
						"Durable Objects cannot be relocated once created.",
						"If you deploy with this setting and later change it,",
						"existing data will become inaccessible.",
						"",
						`You selected: ${dataLocation}`,
					].join("\n"),
					"Important",
				);
			}
		}

		const spinner = p.spinner();

		const authToken = await getOrGenerateSecret(
			"AUTH_TOKEN",
			devVars,
			async () => {
				spinner.start("Generating auth token...");
				const token = generateAuthToken();
				spinner.stop("Auth token generated");
				return token;
			},
		);

		// Signing key is special - NEVER overwrite an existing one
		let signingKey: string;
		let signingKeyIsNew = false;

		if (devVars.SIGNING_KEY) {
			p.log.success("Using existing signing key from .dev.vars");
			signingKey = devVars.SIGNING_KEY;
		} else {
			spinner.start("Generating signing keypair...");
			const { privateKey } = await generateSigningKeypair();
			spinner.stop("Signing keypair generated");
			signingKey = privateKey;
			signingKeyIsNew = true;
		}

		const signingKeyPublic = await derivePublicKey(signingKey);

		// Show critical warning about signing key backup (only for new keys)
		if (signingKeyIsNew) {
			p.log.warn("⚠️  Your signing key controls your identity!");
			p.note(
				[
					"This key signs all your posts and controls your account.",
					"If you lose it, you lose your identity forever.",
					"",
					"Cloudflare secrets CANNOT be retrieved after being set.",
					"Your only copy will be in .dev.vars (this directory).",
					"",
					"We strongly recommend backing it up now.",
				].join("\n"),
				"Critical: Back Up Your Signing Key",
			);

			// Check if 1Password CLI is available
			const has1Password = await is1PasswordAvailable();

			// Build backup options dynamically
			type BackupOption = "1password" | "copy" | "file" | "show" | "skip";
			const backupOptions: Array<{
				value: BackupOption;
				label: string;
				hint: string;
			}> = [];

			if (has1Password) {
				backupOptions.push({
					value: "1password" as const,
					label: "Save to 1Password",
					hint: "recommended - uses op CLI",
				});
			}

			backupOptions.push(
				{
					value: "copy" as const,
					label: "Copy to clipboard",
					hint: "paste into password manager",
				},
				{
					value: "file" as const,
					label: "Save to file",
					hint: "signing-key-backup.txt",
				},
				{
					value: "show" as const,
					label: "Display it (I'll copy manually)",
					hint: "shown in terminal",
				},
				{
					value: "skip" as const,
					label: "Skip (I understand the risk)",
					hint: "not recommended",
				},
			);

			const backupChoice = await promptSelect<BackupOption>({
				message: "How would you like to back up your signing key?",
				options: backupOptions,
			});

			if (backupChoice === "1password") {
				spinner.start("Saving to 1Password...");
				const result = await saveTo1Password(signingKey, handle);
				if (result.success) {
					spinner.stop("Saved to 1Password");
					p.log.success(`Created: "${result.itemName}"`);
				} else {
					spinner.stop("Failed to save to 1Password");
					p.log.error(result.error || "Unknown error");
					p.log.info("Falling back to displaying the key...");
					p.note(
						[
							"SIGNING KEY (keep this secret!):",
							"",
							signingKey,
							"",
							"Copy this to your password manager now.",
						].join("\n"),
						"🔑 Your Signing Key",
					);
				}
			} else if (backupChoice === "copy") {
				await copyToClipboard(signingKey);
				p.log.success("Signing key copied to clipboard");
				p.log.info("Paste it into your password manager now!");
			} else if (backupChoice === "file") {
				const backupPath = await saveKeyBackup(signingKey, handle);
				p.log.success(`Signing key saved to: ${backupPath}`);
				p.log.warn(
					"Move this file to a secure location and delete the local copy!",
				);
			} else if (backupChoice === "show") {
				p.note(
					[
						"SIGNING KEY (keep this secret!):",
						"",
						signingKey,
						"",
						"Copy this to your password manager now.",
					].join("\n"),
					"🔑 Your Signing Key",
				);
			}

			if (backupChoice !== "skip") {
				const confirmed = await promptConfirm({
					message: "Have you saved your signing key securely?",
					initialValue: true,
				});
				if (!confirmed) {
					p.log.warn("Please back up your key before continuing!");
					// Show it one more time
					p.note(signingKey, "🔑 Signing Key");
				}
			}
		}

		const jwtSecret = await getOrGenerateSecret(
			"JWT_SECRET",
			devVars,
			async () => {
				spinner.start("Generating JWT secret...");
				const secret = generateJwtSecret();
				spinner.stop("JWT secret generated");
				return secret;
			},
		);

		const passwordHash = await getOrGenerateSecret(
			"PASSWORD_HASH",
			devVars,
			async () => {
				const password = await promptPassword(handle);
				spinner.start("Hashing password...");
				const hash = await hashPassword(password);
				spinner.stop("Password hashed");
				return hash;
			},
		);

		// Always set public vars and worker name in wrangler.jsonc
		spinner.start("Updating wrangler.jsonc...");
		setWorkerName(workerName);
		setVars({
			PDS_HOSTNAME: hostname,
			DID: did,
			HANDLE: handle,
			SIGNING_KEY_PUBLIC: signingKeyPublic,
			INITIAL_ACTIVE: initialActive,
			DATA_LOCATION: dataLocation,
		});
		setCustomDomains([hostname]);
		spinner.stop("wrangler.jsonc updated");

		// Set secrets
		const local = !isProduction;
		if (isProduction) {
			spinner.start("Deploying secrets to Cloudflare...");
		} else {
			spinner.start("Writing secrets to .dev.vars...");
		}

		await setSecretValue("AUTH_TOKEN", authToken, local);
		// Only write signing key if it's new - never overwrite an existing one
		if (signingKeyIsNew) {
			await setSecretValue("SIGNING_KEY", signingKey, local);
		}
		await setSecretValue("JWT_SECRET", jwtSecret, local);
		await setSecretValue("PASSWORD_HASH", passwordHash, local);

		spinner.stop(
			isProduction ? "Secrets deployed" : "Secrets written to .dev.vars",
		);

		// Generate TypeScript types
		spinner.start("Generating TypeScript types...");
		try {
			await runWrangler(["types"], { throwOnError: true });
			spinner.stop("TypeScript types generated");
		} catch {
			spinner.stop("Failed to generate types (wrangler types)");
		}

		p.note(
			[
				"  Worker name:  " + workerName,
				"  PDS hostname: " + hostname,
				"  DID: " + did,
				"  Handle: " + handle,
				"  Public signing key: " + signingKeyPublic.slice(0, 20) + "...",
				"",
				isProduction
					? "Secrets deployed to Cloudflare ☁️"
					: "Secrets saved to .dev.vars",
			].join("\n"),
			"Your New Home 🏠",
		);

		// For local mode, offer to deploy secrets to Cloudflare
		let deployedSecrets = isProduction;
		if (!isProduction) {
			const deployNow = await p.confirm({
				message: "Push secrets to Cloudflare now?",
				initialValue: false,
			});

			if (!p.isCancel(deployNow) && deployNow) {
				spinner.start("Deploying secrets to Cloudflare...");
				await setSecretValue("AUTH_TOKEN", authToken, false);
				// Only push signing key if it's new - never overwrite an existing one
				if (signingKeyIsNew) {
					await setSecretValue("SIGNING_KEY", signingKey, false);
				}
				await setSecretValue("JWT_SECRET", jwtSecret, false);
				await setSecretValue("PASSWORD_HASH", passwordHash, false);
				spinner.stop("Secrets deployed to Cloudflare");
				deployedSecrets = true;
			}
		}

		// Offer to deploy to Cloudflare if secrets are deployed
		let deployed = false;
		if (deployedSecrets) {
			const deployWorker = await p.confirm({
				message: "Deploy to Cloudflare now?",
				initialValue: true,
			});

			if (!p.isCancel(deployWorker) && deployWorker) {
				p.log.step("Deploying to Cloudflare...");
				try {
					await runCommand(pm, ["run", "deploy"], { stream: true });
					p.log.success("Deployed to Cloudflare! 🚀");
					deployed = true;
				} catch (error) {
					p.log.error(
						`Failed to deploy: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
					p.log.info(
						`You can deploy manually with: ${formatCommand(pm, "deploy")}`,
					);
				}
			}
		}

		if (isMigrating) {
			const nextSteps = deployed
				? [
						"Run the migration:",
						"",
						`  ${formatCommand(pm, "pds", "migrate")}`,
						"",
						"Then update your identity and flip the switch! 🦋",
						"  https://atproto.com/guides/account-migration",
					]
				: [
						deployedSecrets
							? "Deploy your worker and run the migration:"
							: "Push secrets, deploy, and run the migration:",
						"",
						...(deployedSecrets
							? []
							: [`  ${formatCommand(pm, "pds", "init", "--production")}`, ""]),
						`  ${formatCommand(pm, "deploy")}`,
						`  ${formatCommand(pm, "pds", "migrate")}`,
						"",
						"To test locally first:",
						`  ${formatCommand(pm, "dev")}              # in one terminal`,
						`  ${formatCommand(pm, "pds", "migrate", "--dev")}  # in another`,
						"",
						"Then update your identity and flip the switch! 🦋",
						"  https://atproto.com/guides/account-migration",
					];
			p.note(nextSteps.join("\n"), "Next Steps 🧳");
		}

		if (deployed) {
			p.outro(`Your PDS is live at https://${hostname}! 🚀`);
		} else if (deployedSecrets) {
			p.outro(`Run '${formatCommand(pm, "deploy")}' to launch your PDS! 🚀`);
		} else {
			p.outro(
				`Run '${formatCommand(pm, "dev")}' to start your PDS locally! 🦋`,
			);
		}
	},
});

/**
 * Helper to get a secret from .dev.vars or generate a new one
 */
async function getOrGenerateSecret(
	name: SecretName,
	devVars: Record<string, string>,
	generate: () => Promise<string>,
): Promise<string> {
	if (devVars[name]) {
		const useExisting = await p.confirm({
			message: `Use ${name} from .dev.vars?`,
			initialValue: true,
		});
		if (useExisting === true) {
			return devVars[name];
		}
	}
	return generate();
}
