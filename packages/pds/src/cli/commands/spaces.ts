/**
 * Spaces commands - manage the atproto spaces alpha.
 *
 * All commands go through the Worker's authenticated XRPC surface, like
 * the other management commands. `reset` and `status` work even when the
 * flag is off or the space DOs refuse an outdated schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { getTargetUrl } from "../utils/cli-helpers.js";
import {
	generateKemKeypair,
	setPublicVar,
	setSecretValue,
} from "../utils/secrets.js";
import { PlcDirectoryClient } from "../utils/plc-client.js";
import { DidResolver } from "../../did-resolver.js";

interface SpacesContext {
	baseUrl: string;
	authToken: string;
	did: string;
}

function loadContext(isDev: boolean): SpacesContext {
	const config = { ...readDevVars(), ...getVars() };
	let baseUrl: string;
	try {
		baseUrl = getTargetUrl(isDev, config.PDS_HOSTNAME);
	} catch (err) {
		console.error(
			pc.red("Error:"),
			err instanceof Error ? err.message : "Configuration error",
		);
		console.log(pc.dim("Run 'pds init' first to configure your PDS."));
		process.exit(1);
	}
	if (!config.AUTH_TOKEN || !config.DID) {
		console.error(
			pc.red("Error:"),
			"No AUTH_TOKEN or DID found. Run 'pds init' first.",
		);
		process.exit(1);
	}
	return { baseUrl, authToken: config.AUTH_TOKEN, did: config.DID };
}

async function xrpc<T>(
	ctx: SpacesContext,
	method: "GET" | "POST",
	nsid: string,
	options: { params?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
	const url = new URL(`${ctx.baseUrl}/xrpc/${nsid}`);
	for (const [key, value] of Object.entries(options.params ?? {})) {
		url.searchParams.set(key, value);
	}
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${ctx.authToken}`,
			...(options.body !== undefined
				? { "Content-Type": "application/json" }
				: {}),
		},
		...(options.body !== undefined
			? { body: JSON.stringify(options.body) }
			: {}),
	});
	if (!res.ok) {
		const text = await res.text();
		let message = text;
		try {
			const parsed = JSON.parse(text) as { error?: string; message?: string };
			message = parsed.error
				? `${parsed.error}: ${parsed.message ?? ""}`
				: text;
		} catch {
			// keep raw text
		}
		throw new Error(`${nsid} failed (${res.status}): ${message}`);
	}
	const text = await res.text();
	return (text ? JSON.parse(text) : {}) as T;
}

interface SpaceStatusEntry {
	uri: string;
	role: string;
	state: string;
	outdated: boolean;
	policy: string | null;
	recordCount: number;
	memberCount: number;
	writerCount: number;
}

interface SpacesStatus {
	enabled: boolean;
	schemaVersion: number;
	kem?: { configured: boolean; didKey?: string };
	stats: {
		total: number;
		active: number;
		pending: number;
		deleted: number;
		hosted: number;
	};
	spaces: SpaceStatusEntry[];
}

const devArg = {
	dev: {
		type: "boolean" as const,
		description: "Target local development server instead of production",
		default: false,
	},
};

const listCommand = defineCommand({
	meta: { name: "list", description: "List spaces this PDS holds data in" },
	args: { ...devArg },
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const status = await xrpc<SpacesStatus>(
			ctx,
			"GET",
			"gg.mk.experimental.getSpacesStatus",
		);
		if (status.spaces.length === 0) {
			console.log(pc.dim("No spaces."));
			return;
		}
		for (const space of status.spaces) {
			const flags = [
				space.role,
				space.policy
					? space.policy.replace(/^com\.atproto\.|\.policy$/g, "")
					: null,
				space.state !== "active" ? pc.yellow(space.state) : null,
				space.outdated ? pc.red("outdated") : null,
			]
				.filter(Boolean)
				.join(", ");
			console.log(`${pc.bold(space.uri)}  ${pc.dim(`(${flags})`)}`);
			console.log(
				pc.dim(
					`  records: ${space.recordCount}  members: ${space.memberCount}  writers: ${space.writerCount}`,
				),
			);
		}
	},
});

const statusCommand = defineCommand({
	meta: { name: "status", description: "Show spaces flag, schema and counts" },
	args: { ...devArg },
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const status = await xrpc<SpacesStatus>(
			ctx,
			"GET",
			"gg.mk.experimental.getSpacesStatus",
		);
		console.log();
		console.log(pc.bold("Spaces status"));
		console.log(
			`  flag:           ${status.enabled ? pc.green("enabled") : pc.yellow("disabled")}`,
		);
		console.log(`  schema version: ${status.schemaVersion}`);
		console.log(
			`  spaces:         ${status.stats.active} active (${status.stats.hosted} hosted), ${status.stats.pending} pending, ${status.stats.deleted} deleted`,
		);
		const outdated = status.spaces.filter((s) => s.outdated);
		if (outdated.length > 0) {
			console.log(
				pc.red(
					`  ${outdated.length} space(s) hold data from an incompatible alpha build. Run 'pds spaces reset'.`,
				),
			);
		}
		await reportKem(ctx, status.kem);
	},
});

/**
 * Check that the deployed `#atproto_kem` key is the one the DID document
 * publishes: syncers derive MAC secrets against the published key, so a
 * mismatch fails every credentialed read that returns a commit or record.
 */
async function reportKem(
	ctx: SpacesContext,
	kem: SpacesStatus["kem"],
): Promise<void> {
	if (!kem?.configured) {
		console.log(
			pc.yellow(
				"  kem key:        not configured — syncers cannot verify space data. Run 'pds spaces kem'.",
			),
		);
		return;
	}
	let published: string | undefined;
	try {
		const doc = await new DidResolver().resolve(ctx.did, {
			forceRefresh: true,
		});
		const method = (
			(doc?.verificationMethod ?? []) as Array<{
				id: string;
				publicKeyMultibase?: string;
			}>
		).find((m) => m.id.endsWith("#atproto_kem"));
		published = method?.publicKeyMultibase
			? `did:key:${method.publicKeyMultibase}`
			: undefined;
	} catch {
		// reported below as unpublished
	}
	if (!kem.didKey) {
		console.log(
			pc.yellow(
				"  kem key:        secret set, but SPACES_KEM_KEY_PUBLIC is missing. Re-run 'pds spaces kem'.",
			),
		);
	} else if (published === kem.didKey) {
		console.log(
			`  kem key:        ${pc.green("published")} ${pc.dim(kem.didKey)}`,
		);
	} else {
		console.log(
			pc.yellow(
				`  kem key:        ${published ? "DID document publishes a different key" : "not in the DID document"}. ${ctx.did.startsWith("did:plc:") ? "Run 'pds spaces kem --publish'." : "Redeploy so the DID document picks it up."}`,
			),
		);
	}
}

const createCommand = defineCommand({
	meta: { name: "create", description: "Create a hosted space" },
	args: {
		...devArg,
		type: {
			type: "string",
			description: "Space type NSID (e.g. app.bsky.group)",
			required: true,
		},
		skey: {
			type: "string",
			description: "Space key (defaults to a fresh TID)",
		},
		policy: {
			type: "string",
			description: "Policy: personal | member | managed",
			default: "member",
		},
		"public-read": {
			type: "boolean",
			description:
				"member: anyone may read, with or without a delegation token",
			default: false,
		},
		"public-write": {
			type: "boolean",
			description: "member: track anyone's writes, not only members'",
			default: false,
		},
		"managing-app": {
			type: "string",
			description: "managed: the managing app's service identifier",
		},
		allow: {
			type: "string",
			description:
				"member: allowed OAuth client ID (repeatable); only these apps may read",
		},
		"publish-policy": {
			type: "boolean",
			description: "Publish the policy to readers as a record in your repo",
			default: false,
		},
		"publish-members": {
			type: "boolean",
			description: "member: publish the member list to readers",
			default: false,
		},
	},
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const allowed = args.allow
			? Array.isArray(args.allow)
				? args.allow
				: [args.allow]
			: undefined;
		let policy: Record<string, unknown>;
		switch (args.policy) {
			case "personal":
				policy = { $type: "com.atproto.personalspace.policy" };
				break;
			case "managed":
				if (!args["managing-app"]) {
					console.error(pc.red("Error:"), "--managing-app is required");
					process.exit(1);
				}
				policy = {
					$type: "com.atproto.managedspace.policy",
					managingApp: args["managing-app"],
					publishPolicy: args["publish-policy"],
				};
				break;
			case "member":
				policy = {
					$type: "com.atproto.memberspace.policy",
					publicRead: args["public-read"],
					publicWrite: args["public-write"],
					...(allowed ? { allowedApps: allowed } : {}),
					publishPolicy: args["publish-policy"],
					publishMembers: args["publish-members"],
				};
				break;
			default:
				console.error(
					pc.red("Error:"),
					`Unknown policy '${args.policy}' (personal | member | managed)`,
				);
				process.exit(1);
		}
		const result = await xrpc<{ uri: string }>(
			ctx,
			"POST",
			"com.atproto.space.createSpace",
			{
				body: {
					spaceType: args.type,
					...(args.skey ? { skey: args.skey } : {}),
					policy,
				},
			},
		);
		console.log(pc.green("Created:"), result.uri);
	},
});

const deleteCommand = defineCommand({
	meta: { name: "delete", description: "Delete a hosted space" },
	args: {
		...devArg,
		space: { type: "positional", description: "Space URI", required: true },
		yes: {
			type: "boolean",
			alias: "y",
			description: "Skip confirmation",
			default: false,
		},
	},
	async run({ args }) {
		const ctx = loadContext(args.dev);
		if (!args.yes) {
			const confirmed = await p.confirm({
				message: `Delete ${args.space}? Registered syncers will be told to drop their copies.`,
				initialValue: false,
			});
			if (p.isCancel(confirmed) || !confirmed) {
				p.cancel("Cancelled.");
				return;
			}
		}
		await xrpc(ctx, "POST", "com.atproto.space.deleteSpace", {
			body: { space: args.space },
		});
		console.log(pc.green("Deleted:"), args.space);
	},
});

const membersCommand = defineCommand({
	meta: { name: "members", description: "Manage a hosted space's member list" },
	subCommands: {
		add: defineCommand({
			meta: {
				name: "add",
				description: "Add a member, or replace their access",
			},
			args: {
				...devArg,
				space: { type: "positional", description: "Space URI", required: true },
				did: { type: "positional", description: "Member DID", required: true },
				read: {
					type: "boolean",
					description: "May read (use --no-read to deny)",
					default: true,
				},
				write: {
					type: "boolean",
					description: "Writes are tracked (use --no-write to deny)",
					default: true,
				},
			},
			async run({ args }) {
				const ctx = loadContext(Boolean(args.dev));
				await xrpc(ctx, "POST", "com.atproto.memberspace.putMember", {
					body: {
						space: args.space,
						did: args.did,
						read: args.read,
						write: args.write,
					},
				});
				console.log(
					pc.green("Added:"),
					args.did,
					pc.dim(`(read: ${args.read}, write: ${args.write})`),
				);
			},
		}),
		remove: defineCommand({
			meta: { name: "remove", description: "Remove a member" },
			args: {
				...devArg,
				space: { type: "positional", description: "Space URI", required: true },
				did: { type: "positional", description: "Member DID", required: true },
			},
			async run({ args }) {
				const ctx = loadContext(Boolean(args.dev));
				await xrpc(ctx, "POST", "com.atproto.memberspace.removeMember", {
					body: { space: args.space, did: args.did },
				});
				console.log(pc.green("Removed:"), args.did);
			},
		}),
		list: defineCommand({
			meta: { name: "list", description: "List members" },
			args: {
				...devArg,
				space: { type: "positional", description: "Space URI", required: true },
			},
			async run({ args }) {
				const ctx = loadContext(Boolean(args.dev));
				const result = await xrpc<{
					members: Array<{ did: string; read: boolean; write: boolean }>;
				}>(ctx, "GET", "com.atproto.memberspace.listMembers", {
					params: { space: String(args.space), limit: "1000" },
				});
				if (result.members.length === 0) {
					console.log(pc.dim("No members."));
					return;
				}
				for (const member of result.members) {
					const access = [
						member.read ? "read" : null,
						member.write ? "write" : null,
					]
						.filter(Boolean)
						.join(", ");
					console.log(`${member.did}  ${pc.dim(`(${access || "no access"})`)}`);
				}
			},
		}),
	},
});

const exportCommand = defineCommand({
	meta: {
		name: "export",
		description:
			"Export every space repo as a STAR archive, plus the host-side state of hosted spaces",
	},
	args: {
		...devArg,
		out: {
			type: "string",
			description: "Output directory",
			default: "./spaces-export",
		},
	},
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const status = await xrpc<SpacesStatus>(
			ctx,
			"GET",
			"gg.mk.experimental.getSpacesStatus",
		);
		const exportable = status.spaces.filter(
			(space) => space.state === "active" && !space.outdated,
		);
		if (exportable.length === 0) {
			console.log(pc.dim("Nothing to export."));
			return;
		}
		mkdirSync(args.out, { recursive: true });
		const download = async (
			nsid: string,
			params: Record<string, string>,
			filename: string,
			label: string,
		): Promise<void> => {
			const url = new URL(`${ctx.baseUrl}/xrpc/${nsid}`);
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${ctx.authToken}` },
			});
			if (!res.ok) {
				console.log(pc.red("✗"), `${label}: export failed (${res.status})`);
				return;
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			writeFileSync(join(args.out, filename), bytes);
			console.log(
				pc.green("✓"),
				`${label} → ${filename} (${bytes.length} bytes)`,
			);
		};
		for (const space of exportable) {
			const base = space.uri
				.replace("at://", "")
				.replace(/[^a-zA-Z0-9._-]+/g, "_");
			// The space meta archive first: importSpaceMeta must precede
			// importRepo for a space you are the authority of.
			if (space.role === "authority") {
				await download(
					"com.atproto.space.exportSpaceMeta",
					{ space: space.uri },
					`${base}.meta.star`,
					`${space.uri} (space)`,
				);
			}
			if (space.recordCount > 0) {
				await download(
					"com.atproto.space.getRepo",
					{ space: space.uri, repo: ctx.did },
					`${base}.star`,
					`${space.uri} (repo)`,
				);
			}
		}
	},
});

const kemCommand = defineCommand({
	meta: {
		name: "kem",
		description:
			"Generate the #atproto_kem key syncers verify space data against, and publish it",
	},
	args: {
		...devArg,
		local: {
			type: "boolean",
			description: "Write to .dev.vars instead of wrangler secrets/config",
			default: false,
		},
		publish: {
			type: "boolean",
			description:
				"did:plc: add the key to your DID document via a PLC operation signed by this PDS",
			default: false,
		},
	},
	async run({ args }) {
		p.intro("Spaces KEM key");
		const config = { ...readDevVars(), ...getVars() };
		const did = config.DID;
		if (!did) {
			p.log.error("No DID configured. Run 'pds init' first.");
			process.exit(1);
		}

		let publicKey = config.SPACES_KEM_KEY_PUBLIC;
		if (publicKey && !args.publish) {
			const replace = await p.confirm({
				message:
					"A KEM key is already configured. Replace it? Syncers holding the old key will fail to verify until the DID document is updated.",
				initialValue: false,
			});
			if (p.isCancel(replace) || !replace) {
				p.cancel("Kept the existing key.");
				return;
			}
		}
		if (!publicKey || !args.publish) {
			const keypair = await generateKemKeypair();
			await setSecretValue("SPACES_KEM_KEY", keypair.privateKey, args.local);
			setPublicVar("SPACES_KEM_KEY_PUBLIC", keypair.publicKey, args.local);
			publicKey = keypair.publicKey;
			p.log.success(`Generated did:key:${publicKey}`);
		}
		const didKey = `did:key:${publicKey}`;

		if (did.startsWith("did:web:")) {
			p.outro(
				"did:web: the DID document is served by your PDS, so it publishes #atproto_kem once you redeploy.",
			);
			return;
		}
		if (!args.publish) {
			p.note(
				[
					"Your DID is a did:plc, so the key must be added to its PLC document",
					"as the `atproto_kem` verification method. Redeploy, then run:",
					"",
					"  pds spaces kem --publish",
					"",
					"That asks your PDS to sign the PLC operation, which works when its",
					"signing key is one of your DID's rotation keys (true after migrating",
					"with Cirrus). Otherwise, add it with whoever holds your rotation key.",
				].join("\n"),
				"Publish the key",
			);
			p.outro("Done.");
			return;
		}

		const ctx = loadContext(args.dev);
		const spinner = p.spinner();
		spinner.start("Fetching the current PLC operation...");
		const log = await new PlcDirectoryClient().getAuditLog(did);
		const current = log.filter((entry) => !entry.nullified).pop();
		if (!current) {
			spinner.stop("Could not read the PLC audit log");
			process.exit(1);
		}
		const verificationMethods = {
			...current.operation.verificationMethods,
			atproto_kem: didKey,
		};
		spinner.message("Signing the PLC operation...");
		const { token } = await xrpc<{ token: string }>(
			ctx,
			"GET",
			"gg.mk.experimental.getMigrationToken",
		);
		const { operation } = await xrpc<{ operation: unknown }>(
			ctx,
			"POST",
			"com.atproto.identity.signPlcOperation",
			{ body: { token, verificationMethods } },
		);
		spinner.message("Submitting to the PLC directory...");
		try {
			await xrpc(ctx, "POST", "com.atproto.identity.submitPlcOperation", {
				body: { operation },
			});
		} catch (err) {
			spinner.stop("The PLC directory refused the operation");
			p.log.error(err instanceof Error ? err.message : String(err));
			p.log.info(
				"This PDS's signing key is probably not a rotation key for your DID. Add the atproto_kem verification method with whoever holds it.",
			);
			process.exit(1);
		}
		spinner.stop("Published #atproto_kem");
		p.outro(didKey);
	},
});

const resetCommand = defineCommand({
	meta: {
		name: "reset",
		description:
			"Delete ALL space data (space DOs, index, space blobs). The public repo, staged and public blobs, and OAuth state are untouched.",
	},
	args: {
		...devArg,
		yes: {
			type: "boolean",
			alias: "y",
			description: "Skip confirmation",
			default: false,
		},
	},
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const status = await xrpc<SpacesStatus>(
			ctx,
			"GET",
			"gg.mk.experimental.getSpacesStatus",
		);
		console.log();
		console.log(pc.bold("This will permanently delete:"));
		console.log(
			`  - ${status.stats.total} space(s) and their records, members, writers and oplogs`,
		);
		console.log("  - the space index");
		console.log(`  - every blob under ${ctx.did}/space/`);
		console.log();
		console.log(
			pc.dim(
				"The public repo, its blobs, staged uploads and OAuth state are not touched.",
			),
		);
		if (!args.yes) {
			const confirmed = await p.confirm({
				message: "Reset all space data?",
				initialValue: false,
			});
			if (p.isCancel(confirmed) || !confirmed) {
				p.cancel("Cancelled.");
				return;
			}
		}
		const result = await xrpc<{
			spacesDeleted: number;
			blobsDeleted: number;
		}>(ctx, "POST", "gg.mk.experimental.spacesReset");
		console.log(
			pc.green("Reset complete:"),
			`${result.spacesDeleted} space(s), ${result.blobsDeleted} blob(s) deleted.`,
		);
	},
});

export const spacesCommand = defineCommand({
	meta: {
		name: "spaces",
		description: "Manage atproto spaces (alpha)",
	},
	subCommands: {
		list: listCommand,
		status: statusCommand,
		create: createCommand,
		delete: deleteCommand,
		members: membersCommand,
		export: exportCommand,
		kem: kemCommand,
		reset: resetCommand,
	},
});
