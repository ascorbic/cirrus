/**
 * Migration command - transfers account data from source PDS to new PDS
 */
import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient, PDSClientError } from "../utils/pds-client.js";
import { DidResolver } from "../../did-resolver.js";

import { getTargetUrl, getDomain } from "../utils/cli-helpers.js";
import { getPdsEndpoint } from "@atproto/common-web";
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

function detectPackageManager(): PackageManager {
	const userAgent = process.env.npm_config_user_agent || "";
	if (userAgent.startsWith("yarn")) return "yarn";
	if (userAgent.startsWith("pnpm")) return "pnpm";
	if (userAgent.startsWith("bun")) return "bun";
	return "npm";
}

// Helper to override clack's dim styling in notes
const brightNote = (lines: string[]) =>
	lines.map((l) => `\x1b[0m${l}`).join("\n");

/**
 * Format number with commas
 */
function num(n: number): string {
	return n.toLocaleString();
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const migrateCommand = defineCommand({
	meta: {
		name: "migrate",
		description: "Migrate account from source PDS to your new PDS",
	},
	args: {
		clean: {
			type: "boolean",
			description: "Reset migration and start fresh",
			default: false,
		},
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
	},
	async run({ args }) {
		const packageManager = detectPackageManager();
		const pm = packageManager === "npm" ? "npm run" : packageManager;
		const isDev = args.dev;

		// Get target URL
		const vars = getVars();
		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, vars.PDS_HOSTNAME);
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : "Configuration error");
			p.log.info("Run 'pds init' first to configure your PDS.");
			process.exit(1);
		}

		const targetDomain = getDomain(targetUrl);

		p.intro("🦋 PDS Migration");

		const spinner = p.spinner();
		spinner.start(`Checking PDS at ${targetDomain}...`);

		const targetClient = new PDSClient(targetUrl);
		const isHealthy = await targetClient.healthCheck();

		if (!isHealthy) {
			spinner.stop(`PDS not responding at ${targetDomain}`);
			if (isDev) {
				p.log.error(`Your local PDS isn't running at ${targetUrl}`);
				p.log.info(`Start it with: ${pm} dev`);
			} else {
				p.log.error(`Your PDS isn't responding at ${targetUrl}`);
				p.log.info("Make sure your worker is deployed: wrangler deploy");
				p.log.info(`Or test locally first: ${pm} pds migrate --dev`);
			}
			p.outro("Migration cancelled.");
			process.exit(1);
		}
		spinner.stop(`Connected to ${targetDomain}`);

		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		const did = config.DID;
		const handle = config.HANDLE;
		const authToken = config.AUTH_TOKEN;

		if (!did) {
			p.log.error("No DID configured. Run 'pds init' first.");
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		if (!authToken) {
			p.log.error("No AUTH_TOKEN found. Run 'pds init' first.");
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		targetClient.setAuthToken(authToken);

		spinner.start(`Looking up @${handle}...`);

		const didResolver = new DidResolver();
		const didDoc = await didResolver.resolve(did);

		if (!didDoc) {
			spinner.stop("Failed to resolve DID");
			p.log.error(`Could not resolve DID: ${did}`);
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		const sourcePdsUrl = getPdsEndpoint(didDoc);
		if (!sourcePdsUrl) {
			spinner.stop("No PDS found in DID document");
			p.log.error("Could not find PDS endpoint in DID document");
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		const sourceDomain = getDomain(sourcePdsUrl);
		spinner.stop(`Found your account at ${sourceDomain}`);

		spinner.start("Checking account status...");

		const isBlueskyPds = sourceDomain.endsWith(".bsky.network");
		const pdsDisplayName = isBlueskyPds ? "bsky.social" : sourceDomain;

		let status;
		try {
			status = await targetClient.getAccountStatus();
		} catch (err) {
			spinner.stop("Failed to get account status");
			p.log.error(
				err instanceof Error ? err.message : "Could not get account status",
			);
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		spinner.stop("Account status retrieved");

		if (args.clean) {
			if (status.active) {
				p.log.error("Cannot reset: account is active");
				p.log.info("The --clean flag only works on deactivated accounts.");
				p.log.info("Your account is already live");
				p.log.info("");
				p.log.info("If you need to re-import, first deactivate:");
				p.log.info("  pnpm pds deactivate");
				p.outro("Migration cancelled.");
				process.exit(1);
			}

			// Show what will be deleted
			p.note(
				brightNote([
					pc.bold("This will permanently delete from your new PDS:"),
					"",
					`  • ${num(status.repoBlocks)} repository blocks`,
					`  • ${num(status.importedBlobs)} imported images`,
					"  • All blob tracking data",
					"",
					pc.bold(`Your data on ${pdsDisplayName} is NOT affected.`),
					"You'll need to re-import everything.",
				]),
				"⚠️  Reset Migration Data",
			);

			const confirmReset = await p.confirm({
				message: "Are you sure you want to delete this data?",
				initialValue: false,
			});

			if (p.isCancel(confirmReset) || !confirmReset) {
				p.cancel("Keeping your data.");
				process.exit(0);
			}

			spinner.start("Resetting migration state...");
			try {
				const result = await targetClient.resetMigration();
				spinner.stop(
					`Deleted ${num(result.blocksDeleted)} blocks, ${num(result.blobsCleared)} blobs`,
				);
			} catch (err) {
				spinner.stop("Reset failed");
				p.log.error(
					err instanceof Error ? err.message : "Could not reset migration",
				);
				p.outro("Migration cancelled.");
				process.exit(1);
			}

			p.log.success("Clean slate! Starting fresh migration...");

			// Refresh status after reset
			status = await targetClient.getAccountStatus();
		}

		if (status.active) {
			p.log.warn(`Your account is already active at ${targetDomain}!`);
			p.log.info("No migration needed - your PDS is live.");
			p.outro("All good!");
			return;
		}

		spinner.start(`Fetching your account details from ${pdsDisplayName}...`);

		const sourceClient = new PDSClient(sourcePdsUrl);
		try {
			await sourceClient.describeRepo(did);
		} catch (err) {
			spinner.stop("Failed to fetch account details");
			p.log.error(
				err instanceof Error
					? err.message
					: "Could not fetch account details from source PDS",
			);
			p.outro("Migration cancelled.");
			process.exit(1);
		}
		// Also fetch profile stats from AppView
		const profileStats = await sourceClient.getProfileStats(did);
		spinner.stop("Account details fetched");

		// Determine what to do based on current state
		// A fresh account from init has repoBlocks but no indexedRecords
		const needsRepoImport =
			status.repoBlocks === 0 ||
			(status.indexedRecords === 0 && status.expectedBlobs === 0);
		const missingBlobs = status.expectedBlobs - status.importedBlobs;
		const needsBlobSync = missingBlobs > 0 || needsRepoImport;
		const isResuming = !needsRepoImport && needsBlobSync;

		if (isResuming) {
			// Resume flow
			p.log.info("Welcome back!");
			p.log.info(
				"Looks like you started packing earlier. Let's pick up where we left off.",
			);

			p.note(
				[
					`@${handle} (${did.slice(0, 20)}...)`,
					"",
					"✓ Repository imported",
					`◐ Media: ${num(status.importedBlobs)}/${num(status.expectedBlobs)} images and videos transferred`,
				].join("\n"),
				"Migration Progress",
			);

			const continueTransfer = await p.confirm({
				message: "Continue transferring images and video?",
				initialValue: true,
			});

			if (p.isCancel(continueTransfer) || !continueTransfer) {
				p.cancel("Migration paused.");
				process.exit(0);
			}
		} else if (needsRepoImport) {
			// Fresh migration
			p.log.info("Time to pack your bags!");
			p.log.info("Let's clone your account to its new home in the Atmosphere.");

			const statsLines = profileStats
				? [
						`  📝 ${num(profileStats.postsCount)} posts`,
						`  👥 ${num(profileStats.followsCount)} follows`,
						`  ...plus all your images, likes and preferences`,
					]
				: [`  📝 Posts, follows, images, likes and preferences`];

			p.note(
				brightNote([
					pc.bold(`@${handle}`) + ` (${did.slice(0, 20)}...)`,
					"",
					`Currently at:  ${sourceDomain}`,
					`Moving to:     ${targetDomain}`,
					"",
					"What you're bringing:",
					...statsLines,
				]),
				"Your Bluesky Account 🦋",
			);

			p.log.info(
				`This will copy your data - nothing is changed or deleted on your current PDS.`,
			);

			const proceed = await p.confirm({
				message: "Ready to start moving?",
				initialValue: true,
			});

			if (p.isCancel(proceed) || !proceed) {
				p.cancel("Migration cancelled.");
				process.exit(0);
			}
		} else {
			// Already complete
			p.log.success("Everything looks good!");
			showNextSteps(pm, pdsDisplayName);
			p.outro("Welcome to your new home in the Atmosphere! 🦋");
			return;
		}

		const password = await p.password({
			message: `Your password for ${pdsDisplayName}:`,
		});

		if (p.isCancel(password)) {
			p.cancel("Migration cancelled.");
			process.exit(0);
		}

		spinner.start(`Logging in to ${pdsDisplayName}...`);
		try {
			const session = await sourceClient.createSession(did, password);
			sourceClient.setAuthToken(session.accessJwt);
			spinner.stop("Authenticated successfully");
		} catch (err) {
			spinner.stop("Login failed");
			if (err instanceof PDSClientError) {
				p.log.error(`Authentication failed: ${err.message}`);
			} else {
				p.log.error(
					err instanceof Error ? err.message : "Authentication failed",
				);
			}
			p.outro("Migration cancelled.");
			process.exit(1);
		}

		if (needsRepoImport) {
			spinner.start(`Exporting your repository from ${pdsDisplayName}...`);
			let carBytes: Uint8Array;
			try {
				carBytes = await sourceClient.getRepo(did);
				spinner.stop(
					`Downloaded ${formatBytes(carBytes.length)} from ${sourceDomain}`,
				);
			} catch (err) {
				spinner.stop("Export failed");
				p.log.error(
					err instanceof Error ? err.message : "Could not export repository",
				);
				p.outro("Migration cancelled.");
				process.exit(1);
			}

			spinner.start(`Importing to ${targetDomain}...`);
			try {
				await targetClient.importRepo(carBytes);
				spinner.stop("Repository imported");
			} catch (err) {
				spinner.stop("Import failed");
				p.log.error(
					err instanceof Error ? err.message : "Could not import repository",
				);
				p.outro("Migration cancelled.");
				process.exit(1);
			}

			// Refresh status to get blob counts
			status = await targetClient.getAccountStatus();
		}

		spinner.start("Migrating your preferences...");
		try {
			const preferences = await sourceClient.getPreferences();
			if (preferences.length > 0) {
				await targetClient.putPreferences(preferences);
				spinner.stop(
					`Migrated ${preferences.length} preference${preferences.length === 1 ? "" : "s"}`,
				);
			} else {
				spinner.stop("No preferences to migrate");
			}
		} catch (err) {
			// Non-fatal - preferences might not be accessible or supported
			spinner.stop("Skipped preferences (not available)");
		}

		const expectedBlobs = status.expectedBlobs;
		const alreadyImported = status.importedBlobs;
		const blobsToSync = expectedBlobs - alreadyImported;

		if (blobsToSync > 0) {
			let synced = 0;
			let totalBlobs = 0;
			let cursor: string | undefined;
			let failedBlobs: string[] = [];

			const progressBar = (current: number, total: number): string => {
				const width = 20;
				const ratio = total > 0 ? Math.min(1, current / total) : 0;
				const filled = Math.round(ratio * width);
				const empty = width - filled;
				return `${"█".repeat(filled)}${"░".repeat(empty)} ${current}/${total}`;
			};

			// First, count total missing blobs
			spinner.start("Counting images to transfer...");
			let countCursor: string | undefined;
			do {
				const page = await targetClient.listMissingBlobs(500, countCursor);
				totalBlobs += page.blobs.length;
				countCursor = page.cursor;
			} while (countCursor);

			spinner.message(`Transferring media ${progressBar(0, totalBlobs)}`);

			do {
				const page = await targetClient.listMissingBlobs(100, cursor);
				cursor = page.cursor;

				for (const blob of page.blobs) {
					try {
						const { bytes, mimeType } = await sourceClient.getBlob(
							did,
							blob.cid,
						);
						await targetClient.uploadBlob(bytes, mimeType);
						synced++;
						spinner.message(
							`Transferring media ${progressBar(synced, totalBlobs)}`,
						);
					} catch (err) {
						synced++;
						failedBlobs.push(blob.cid);
						spinner.message(
							`Transferring media ${progressBar(synced, totalBlobs)}`,
						);
					}
				}
			} while (cursor);

			if (failedBlobs.length > 0) {
				spinner.stop(
					`Transferred ${num(synced - failedBlobs.length)} images and videos (${failedBlobs.length} failed)`,
				);
				p.log.warn(`Run 'pds migrate' again to retry failed transfers.`);
			} else {
				spinner.stop(`Transferred ${num(synced)} images and videos`);
			}
		}

		spinner.start("Verifying migration...");
		const finalStatus = await targetClient.getAccountStatus();
		spinner.stop("Verification complete");

		const allBlobsSynced =
			finalStatus.importedBlobs >= finalStatus.expectedBlobs;

		if (allBlobsSynced) {
			p.log.success("All packed and moved!");
		} else {
			p.log.warn(
				`Migration partially complete. ${finalStatus.expectedBlobs - finalStatus.importedBlobs} images remaining.`,
			);
			p.log.info("Run 'pds migrate' again to continue.");
		}

		showNextSteps(pm, pdsDisplayName);
		p.outro("Welcome to your new home in the Atmosphere! 🦋");
	},
});

function showNextSteps(pm: string, sourceDomain: string): void {
	p.note(
		brightNote([
			pc.bold("Your data is safe in your new PDS."),
			"Two more steps to go live:",
			"",
			pc.bold("1. Update your identity"),
			"   Tell the network where you live now.",
			`   (Requires email verification from ${sourceDomain})`,
			"",
			pc.bold("2. Flip the switch"),
			`   ${pm} pds activate`,
			"",
			"Docs: https://atproto.com/guides/account-migration",
		]),
		"Almost there!",
	);
}
