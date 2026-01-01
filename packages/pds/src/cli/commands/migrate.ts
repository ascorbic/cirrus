/**
 * Migration command - transfers account data from source PDS to local PDS
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
const bold = (text: string) => pc.bold(text);

/**
 * Format number with commas
 */
function formatNumber(n: number): string {
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
		const pm = detectPackageManager();
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

		// ============================================
		// Step 1: Healthcheck
		// ============================================
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

		// ============================================
		// Step 2: Load config
		// ============================================
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

		// Set auth token for target PDS
		targetClient.setAuthToken(authToken);

		// ============================================
		// Step 3: Resolve source PDS from DID
		// ============================================
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

		// ============================================
		// Step 4: Check target state
		// ============================================
		spinner.start("Checking account status...");

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

		// ============================================
		// Handle --clean flag
		// ============================================
		if (args.clean) {
			if (status.active) {
				p.log.error("Cannot reset: account is active");
				p.log.info("The --clean flag only works on deactivated accounts.");
				p.log.info("Your account is already live in the Atmosphere.");
				p.log.info("");
				p.log.info("If you need to re-import, first deactivate:");
				p.log.info("  pnpm pds deactivate");
				p.outro("Migration cancelled.");
				process.exit(1);
			}

			// Show what will be deleted
			p.note(
				brightNote([
					bold("This will permanently delete from your new PDS:"),
					"",
					`  • ${formatNumber(status.repoBlocks)} repository blocks`,
					`  • ${formatNumber(status.importedBlobs)} imported images`,
					"  • All blob tracking data",
					"",
					bold(`Your data on ${sourceDomain} is NOT affected.`),
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
					`Deleted ${formatNumber(result.blocksDeleted)} blocks, ${formatNumber(result.blobsCleared)} blobs`,
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

		// ============================================
		// Check if already active
		// ============================================
		if (status.active) {
			p.log.warn("Your account is already active in the Atmosphere!");
			p.log.info("No migration needed - your PDS is live.");
			p.outro("All good! 🦋");
			return;
		}

		// ============================================
		// Step 5: Fetch source stats
		// ============================================
		spinner.start(`Fetching your account details from ${sourceDomain}...`);

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

		// ============================================
		// Show migration preview
		// ============================================
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
					`◐ Images: ${formatNumber(status.importedBlobs)}/${formatNumber(status.expectedBlobs)} transferred`,
				].join("\n"),
				"Migration Progress",
			);

			const continueTransfer = await p.confirm({
				message: "Continue transferring images?",
				initialValue: true,
			});

			if (p.isCancel(continueTransfer) || !continueTransfer) {
				p.cancel("Migration paused.");
				process.exit(0);
			}
		} else if (needsRepoImport) {
			// Fresh migration
			p.log.info("Time to pack your bags!");
			p.log.info(
				"Let's move your Bluesky account to its new home in the Atmosphere.",
			);

			const statsLines = profileStats
				? [
						`  📝 ${formatNumber(profileStats.postsCount)} posts`,
						`  👥 ${formatNumber(profileStats.followsCount)} follows`,
						`  ...plus all your images, likes, and blocks`,
					]
				: [`  📝 Posts, follows, images, likes, and blocks`];

			p.note(
				brightNote([
					bold(`@${handle}`) + ` (${did.slice(0, 20)}...)`,
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
				"This will copy your data - nothing is changed or deleted on Bluesky.",
			);

			const proceed = await p.confirm({
				message: "Ready to start packing?",
				initialValue: true,
			});

			if (p.isCancel(proceed) || !proceed) {
				p.cancel("Migration cancelled.");
				process.exit(0);
			}
		} else {
			// Already complete
			p.log.success("All packed and moved! 🦋");
			showNextSteps(pm, sourceDomain);
			p.outro("Welcome to your new home in the Atmosphere! 🦋");
			return;
		}

		// ============================================
		// Step 6: Authenticate to source PDS
		// ============================================
		const isBlueskyPds = sourceDomain.endsWith(".bsky.network");
		const passwordPrompt = isBlueskyPds
			? "Your current Bluesky password:"
			: `Your ${sourceDomain} password:`;
		const password = await p.password({
			message: passwordPrompt,
		});

		if (p.isCancel(password)) {
			p.cancel("Migration cancelled.");
			process.exit(0);
		}

		spinner.start(
			`Logging in to ${isBlueskyPds ? "Bluesky" : sourceDomain}...`,
		);
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

		// ============================================
		// Step 7: Export and import repo
		// ============================================
		if (needsRepoImport) {
			spinner.start("Packing your repository...");
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

			spinner.start(`Unpacking at ${targetDomain}...`);
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

		// ============================================
		// Step 8: Migrate preferences
		// ============================================
		spinner.start("Migrating your preferences...");
		try {
			const preferences = await sourceClient.getPreferences();
			if (preferences.length > 0) {
				await targetClient.putPreferences(preferences);
				spinner.stop(`Migrated ${preferences.length} preference${preferences.length === 1 ? "" : "s"}`);
			} else {
				spinner.stop("No preferences to migrate");
			}
		} catch (err) {
			// Non-fatal - preferences might not be accessible or supported
			spinner.stop("Skipped preferences (not available)");
		}

		// ============================================
		// Step 9: Sync blobs
		// ============================================
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

			spinner.message(`Transferring images ${progressBar(0, totalBlobs)}`);

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
							`Transferring images ${progressBar(synced, totalBlobs)}`,
						);
					} catch (err) {
						synced++;
						failedBlobs.push(blob.cid);
						spinner.message(
							`Transferring images ${progressBar(synced, totalBlobs)}`,
						);
					}
				}
			} while (cursor);

			if (failedBlobs.length > 0) {
				spinner.stop(
					`Transferred ${formatNumber(synced - failedBlobs.length)} images (${failedBlobs.length} failed)`,
				);
				p.log.warn(`Run 'pds migrate' again to retry failed transfers.`);
			} else {
				spinner.stop(`Transferred ${formatNumber(synced)} images`);
			}
		}

		// ============================================
		// Step 10: Verify and show next steps
		// ============================================
		spinner.start("Verifying migration...");
		const finalStatus = await targetClient.getAccountStatus();
		spinner.stop("Verification complete");

		const allBlobsSynced =
			finalStatus.importedBlobs >= finalStatus.expectedBlobs;

		if (allBlobsSynced) {
			p.log.success("All packed and moved! 🦋");
		} else {
			p.log.warn(
				`Migration partially complete. ${finalStatus.expectedBlobs - finalStatus.importedBlobs} images remaining.`,
			);
			p.log.info("Run 'pds migrate' again to continue.");
		}

		showNextSteps(pm, sourceDomain);
		p.outro("Welcome to your new home in the Atmosphere! 🦋");
	},
});

function showNextSteps(pm: string, sourceDomain: string): void {
	p.note(
		brightNote([
			bold("Your data is safe in your new PDS."),
			"Two more steps to go live in the Atmosphere:",
			"",
			bold("1. Update your identity"),
			"   Tell the network where you live now.",
			`   (Requires email verification from ${sourceDomain})`,
			"",
			bold("2. Flip the switch"),
			`   ${pm} pds activate`,
			"",
			"Docs: https://atproto.com/guides/account-migration",
		]),
		"Almost there!",
	);
}
