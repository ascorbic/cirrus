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
	return (await res.json()) as T;
}

interface SpaceStatusEntry {
	uri: string;
	role: string;
	state: string;
	outdated: boolean;
	recordCount: number;
	memberCount: number;
	writerCount: number;
}

interface SpacesStatus {
	enabled: boolean;
	schemaVersion: number;
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
	},
});

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
			description: "User policy: public | member-list | managing-app",
			default: "member-list",
		},
		"managing-app": {
			type: "string",
			description: "Managing app service identifier (managing-app policy)",
		},
		allow: {
			type: "string",
			description:
				"Allowed OAuth client ID (repeatable); sets the allowList app policy",
		},
	},
	async run({ args }) {
		const ctx = loadContext(args.dev);
		const policyType = args.policy;
		const policy =
			policyType === "public"
				? { $type: "com.atproto.simplespace.defs#publicPolicy" }
				: policyType === "managing-app"
					? {
							$type: "com.atproto.simplespace.defs#managingAppPolicy",
							managingApp: args["managing-app"],
						}
					: { $type: "com.atproto.simplespace.defs#memberListPolicy" };
		const allowed = args.allow
			? Array.isArray(args.allow)
				? args.allow
				: [args.allow]
			: [];
		const appAccess =
			allowed.length > 0
				? { $type: "com.atproto.simplespace.defs#allowList", allowed }
				: { $type: "com.atproto.simplespace.defs#open" };
		const result = await xrpc<{ uri: string }>(
			ctx,
			"POST",
			"com.atproto.simplespace.createSpace",
			{
				body: {
					type: args.type,
					...(args.skey ? { skey: args.skey } : {}),
					policy,
					appAccess,
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
		await xrpc(ctx, "POST", "com.atproto.simplespace.deleteSpace", {
			body: { space: args.space },
		});
		console.log(pc.green("Deleted:"), args.space);
	},
});

const membersCommand = defineCommand({
	meta: { name: "members", description: "Manage a hosted space's member list" },
	subCommands: {
		add: defineCommand({
			meta: { name: "add", description: "Add a member" },
			args: {
				...devArg,
				space: { type: "positional", description: "Space URI", required: true },
				did: { type: "positional", description: "Member DID", required: true },
			},
			async run({ args }) {
				const ctx = loadContext(args.dev);
				await xrpc(ctx, "POST", "com.atproto.simplespace.addMember", {
					body: { space: args.space, did: args.did },
				});
				console.log(pc.green("Added:"), args.did);
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
				const ctx = loadContext(args.dev);
				await xrpc(ctx, "POST", "com.atproto.simplespace.removeMember", {
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
				const ctx = loadContext(args.dev);
				const result = await xrpc<{ members: Array<{ did: string }> }>(
					ctx,
					"GET",
					"com.atproto.simplespace.listMembers",
					{ params: { space: args.space, limit: "1000" } },
				);
				if (result.members.length === 0) {
					console.log(pc.dim("No members."));
					return;
				}
				for (const member of result.members) {
					console.log(member.did);
				}
			},
		}),
	},
});

const exportCommand = defineCommand({
	meta: {
		name: "export",
		description: "Export every space repo as a CAR file",
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
			(space) =>
				space.state === "active" && !space.outdated && space.recordCount > 0,
		);
		if (exportable.length === 0) {
			console.log(pc.dim("Nothing to export."));
			return;
		}
		mkdirSync(args.out, { recursive: true });
		for (const space of exportable) {
			const url = new URL(`${ctx.baseUrl}/xrpc/com.atproto.space.getRepo`);
			url.searchParams.set("space", space.uri);
			url.searchParams.set("repo", ctx.did);
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${ctx.authToken}` },
			});
			if (!res.ok) {
				console.log(
					pc.red("✗"),
					`${space.uri}: export failed (${res.status})`,
				);
				continue;
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			const filename = `${space.uri
				.replace("at://", "")
				.replace(/[^a-zA-Z0-9._-]+/g, "_")}.car`;
			writeFileSync(join(args.out, filename), bytes);
			console.log(
				pc.green("✓"),
				`${space.uri} → ${filename} (${bytes.length} bytes)`,
			);
		}
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
		reset: resetCommand,
	},
});
