/**
 * Live terminal dashboard for PDS monitoring
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { decodeAll } from "@atproto/lex-cbor";
import { getVars } from "../utils/wrangler.js";
import { readDevVars } from "../utils/dotenv.js";
import { PDSClient } from "../utils/pds-client.js";
import { getTargetUrl } from "../utils/cli-helpers.js";
import {
	checkHandleResolutionDetailed,
	checkDidResolution,
} from "../utils/checks.js";

// ============================================
// ANSI string utilities
// ============================================

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(s: string): number {
	return stripAnsi(s).length;
}

function padRight(s: string, width: number): string {
	const pad = width - visibleLength(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}

function truncate(s: string, width: number): string {
	if (visibleLength(s) <= width) return s;
	// Truncate by stripping ansi, cutting, then re-applying would be complex.
	// Simple approach: strip ansi, truncate, dim the ellipsis
	const plain = stripAnsi(s);
	return plain.slice(0, width - 1) + pc.dim("\u2026");
}

// ============================================
// Terminal control
// ============================================

function enterAltScreen(): void {
	process.stdout.write("\x1b[?1049h");
}

function exitAltScreen(): void {
	process.stdout.write("\x1b[?1049l");
}

function hideCursor(): void {
	process.stdout.write("\x1b[?25l");
}

function showCursor(): void {
	process.stdout.write("\x1b[?25h");
}

function clearScreen(): void {
	process.stdout.write("\x1b[2J\x1b[H");
}

// ============================================
// Column layout
// ============================================

function renderColumns(cols: string[][], widths: number[]): string[] {
	const maxRows = Math.max(...cols.map((c) => c.length));
	const lines: string[] = [];
	for (let i = 0; i < maxRows; i++) {
		let line = "";
		for (let j = 0; j < cols.length; j++) {
			const cell = cols[j]![i] ?? "";
			line += padRight(cell, widths[j]!);
		}
		lines.push(line);
	}
	return lines;
}

// ============================================
// Firehose frame parser
// ============================================

interface FirehoseEvent {
	seq: number;
	type: "commit" | "identity";
	ops: Array<{ action: string; path: string }>;
	handle?: string;
}

function parseFirehoseMessage(data: Uint8Array): FirehoseEvent | null {
	try {
		const decoded = [...decodeAll(data)];
		if (decoded.length !== 2) return null;
		const header = decoded[0] as { op?: number; t?: string };
		const body = decoded[1] as {
			seq?: number;
			ops?: Array<{ action: string; path: string }>;
			handle?: string;
		};
		if (!header || header.op !== 1) return null;
		if (!body || typeof body.seq !== "number") return null;

		if (header.t === "#commit") {
			return {
				seq: body.seq,
				type: "commit",
				ops: (body.ops ?? []).map((op) => ({
					action: op.action,
					path: op.path,
				})),
			};
		}

		if (header.t === "#identity") {
			return {
				seq: body.seq,
				type: "identity",
				ops: [],
				handle: body.handle,
			};
		}

		return null;
	} catch {
		return null;
	}
}

// ============================================
// Collection name mapping
// ============================================

const COLLECTION_NAMES: Record<string, string> = {
	"app.bsky.feed.post": "posts",
	"app.bsky.feed.like": "likes",
	"app.bsky.graph.follow": "follows",
	"app.bsky.feed.repost": "reposts",
	"app.bsky.actor.profile": "profile",
	"app.bsky.graph.block": "blocks",
	"app.bsky.graph.list": "lists",
	"app.bsky.graph.listitem": "list items",
	"app.bsky.feed.generator": "feeds",
	"app.bsky.feed.threadgate": "threadgates",
	"app.bsky.graph.starterpack": "starter packs",
	"chat.bsky.actor.declaration": "chat",
	"app.bsky.feed.postgate": "postgates",
	"app.bsky.labeler.service": "labeler",
};

/** Sort priority for collections (lower = first). Unlisted collections sort alphabetically at the end. */
const COLLECTION_ORDER: Record<string, number> = {
	"app.bsky.feed.post": 1,
	"app.bsky.feed.like": 2,
	"app.bsky.graph.follow": 3,
	"app.bsky.feed.repost": 4,
	"app.bsky.graph.list": 5,
	"app.bsky.feed.generator": 6,
	"app.bsky.graph.block": 7,
	"app.bsky.graph.starterpack": 8,
	"app.bsky.actor.profile": 100,
};

function friendlyName(collection: string): string {
	return (
		COLLECTION_NAMES[collection] ?? collection.split(".").pop() ?? collection
	);
}

/** Shorten IPv6 addresses by collapsing the longest zero run to :: */
function shortenIP(ip: string): string {
	if (!ip.includes(":")) return ip;
	// Expand to full form, then collapse longest zero run
	const parts = ip.split(":");
	// Find longest run of "0" groups
	let bestStart = -1;
	let bestLen = 0;
	let curStart = -1;
	let curLen = 0;
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "0" || parts[i] === "0000" || parts[i] === "") {
			if (curStart === -1) curStart = i;
			curLen++;
		} else {
			if (curLen > bestLen) {
				bestStart = curStart;
				bestLen = curLen;
			}
			curStart = -1;
			curLen = 0;
		}
	}
	if (curLen > bestLen) {
		bestStart = curStart;
		bestLen = curLen;
	}
	if (bestLen < 2) {
		// Strip leading zeros from each group
		return parts.map((p) => p.replace(/^0+(?=.)/, "")).join(":");
	}
	const before = parts
		.slice(0, bestStart)
		.map((p) => p.replace(/^0+(?=.)/, ""));
	const after = parts
		.slice(bestStart + bestLen)
		.map((p) => p.replace(/^0+(?=.)/, ""));
	return (
		(before.length ? before.join(":") : "") +
		"::" +
		(after.length ? after.join(":") : "")
	);
}

// ============================================
// Notification formatting
// ============================================

const REASON_ICON: Record<string, string> = {
	like: pc.red("\u2665"),
	repost: pc.green("\u21bb"),
	follow: pc.cyan("+"),
	mention: pc.yellow("@"),
	reply: pc.cyan("\u21a9"),
	quote: pc.yellow("\u275d"),
	"starterpack-joined": pc.cyan("\u2605"),
};

const REASON_TEXT: Record<string, string> = {
	like: "liked your post",
	repost: "reposted your post",
	follow: "followed you",
	mention: "mentioned you",
	reply: "replied to you",
	quote: "quoted your post",
	"starterpack-joined": "joined your starter pack",
};

function relativeTime(ts: number): string {
	const diff = Math.floor((Date.now() - ts) / 1000);
	if (diff < 10) return "just now";
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

// ============================================
// Dashboard state
// ============================================

interface CollectionInfo {
	name: string;
	friendlyName: string;
	count: number;
	hasMore: boolean;
}

interface DashboardEvent {
	time: string;
	seq: number;
	action: string;
	path: string;
}

interface Notification {
	time: string;
	icon: string;
	author: string;
	text: string;
	isRead: boolean;
}

interface DashboardState {
	collections: CollectionInfo[];
	pdsRev: string | null;
	subscribers: number;
	latestSeq: number | null;
	subscriberDetails: Array<{
		connectedAt: number;
		cursor: number;
		ip: string | null;
	}>;
	events: DashboardEvent[];
	notifications: Notification[];
	accountActive: boolean;
	wsConnected: boolean;
	statusMessage: string | null;
	statusMessageTimeout: ReturnType<typeof setTimeout> | null;
	handleCheck: { ok: boolean; methods: string[] } | null;
	didCheck: { ok: boolean; pdsEndpoint: string | null } | null;
	relayHostStatus: Array<{
		status: "active" | "idle" | "offline" | "throttled" | "banned";
		relay: string;
	}>;
}

const MAX_EVENTS = 100;

function createInitialState(): DashboardState {
	return {
		collections: [],
		pdsRev: null,
		subscribers: 0,
		latestSeq: null,
		subscriberDetails: [],
		events: [],
		notifications: [],
		accountActive: false,
		wsConnected: false,
		statusMessage: null,
		statusMessageTimeout: null,
		handleCheck: null,
		didCheck: null,
		relayHostStatus: [],
	};
}

// ============================================
// Data fetching
// ============================================

async function fetchRepo(
	client: PDSClient,
	did: string,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const reposData = await client.listRepos();
		const repo = reposData.repos?.[0];
		if (repo) state.pdsRev = repo.rev;

		const desc = await client.describeRepo(did);
		const collections = desc.collections ?? [];

		const results = await Promise.all(
			collections.map(async (col) => {
				const data = await client.listRecords(did, col, 100);
				return {
					name: col,
					friendlyName: friendlyName(col),
					count: data.records?.length ?? 0,
					hasMore: !!data.cursor,
				};
			}),
		);

		// Sort by priority order, then alphabetically; filter out empty internal collections
		results.sort((a, b) => {
			const oa = COLLECTION_ORDER[a.name] ?? 50;
			const ob = COLLECTION_ORDER[b.name] ?? 50;
			if (oa !== ob) return oa - ob;
			return a.friendlyName.localeCompare(b.friendlyName);
		});

		state.collections = results.filter((c) => c.count > 0);
		render();
	} catch {
		// Silently retry on next interval
	}
}

async function fetchFirehoseStatus(
	client: PDSClient,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const data = await client.getFirehoseStatus();
		state.subscribers = data.subscribers?.length ?? 0;
		state.subscriberDetails = data.subscribers ?? [];
		if (data.latestSeq != null) state.latestSeq = data.latestSeq;
		render();
	} catch {
		// Silently retry
	}
}

async function fetchNotifications(
	client: PDSClient,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const data = await client.listNotifications(25);
		state.notifications = (data.notifications ?? []).map((n) => ({
			time: new Date(n.indexedAt).toLocaleTimeString("en-GB", {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
			}),
			icon: REASON_ICON[n.reason] ?? "?",
			author: n.author.displayName || n.author.handle,
			text: REASON_TEXT[n.reason] ?? n.reason,
			isRead: n.isRead,
		}));
		render();
	} catch {
		// Notifications may not be available (e.g. account not on AppView yet)
	}
}

async function fetchAccountStatus(
	client: PDSClient,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const status = await client.getAccountStatus();
		state.accountActive = status.active;
		render();
	} catch {
		// Silently retry
	}
}

async function fetchIdentityChecks(
	client: PDSClient,
	handle: string,
	did: string,
	pdsHostname: string,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const [handleResult, didResult] = await Promise.all([
			checkHandleResolutionDetailed(client, handle, did),
			checkDidResolution(client, did, pdsHostname),
		]);
		state.handleCheck = {
			ok: handleResult.ok,
			methods: handleResult.methods,
		};
		state.didCheck = {
			ok: didResult.ok,
			pdsEndpoint: didResult.pdsEndpoint,
		};
		render();
	} catch {
		// Silently retry
	}
}

async function fetchRelayHostStatus(
	client: PDSClient,
	pdsHostname: string,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const statuses = await client.getAllRelayHostStatus(pdsHostname);
		state.relayHostStatus = statuses;
		render();
	} catch {
		// Silently retry
	}
}

// ============================================
// WebSocket firehose connection
// ============================================

function connectFirehose(
	targetUrl: string,
	state: DashboardState,
	render: () => void,
	onCommit?: () => void,
): { close: () => void } {
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	function connect(): void {
		if (closed) return;
		try {
			const proto = targetUrl.startsWith("https") ? "wss:" : "ws:";
			const host = targetUrl.replace(/^https?:\/\//, "");
			const url = `${proto}//${host}/xrpc/com.atproto.sync.subscribeRepos`;
			ws = new WebSocket(url);
			ws.binaryType = "arraybuffer";

			ws.onopen = () => {
				state.wsConnected = true;
				render();
			};

			ws.onmessage = (e: MessageEvent) => {
				const event = parseFirehoseMessage(
					new Uint8Array(e.data as ArrayBuffer),
				);
				if (!event) return;
				const time = new Date().toLocaleTimeString("en-GB", {
					hour12: false,
				});
				if (event.type === "identity") {
					state.events.unshift({
						time,
						seq: event.seq,
						action: "identity",
						path: event.handle ?? "",
					});
				} else {
					for (const op of event.ops) {
						state.events.unshift({
							time,
							seq: event.seq,
							action: op.action,
							path: op.path,
						});
					}
					onCommit?.();
				}
				if (state.events.length > MAX_EVENTS) {
					state.events.length = MAX_EVENTS;
				}
				render();
			};

			ws.onclose = () => {
				state.wsConnected = false;
				render();
				if (!closed) {
					reconnectTimer = setTimeout(connect, 3000);
				}
			};

			ws.onerror = () => {
				state.wsConnected = false;
				render();
			};
		} catch {
			// WebSocket may not be available (Node < 22)
			// Dashboard still works via polling
		}
	}

	connect();

	return {
		close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (ws) {
				ws.onclose = null;
				ws.close();
			}
		},
	};
}

// ============================================
// Render function
// ============================================

function renderDashboard(
	state: DashboardState,
	config: {
		hostname: string;
		handle: string;
		did: string;
		version: string;
	},
): void {
	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;
	const lines: string[] = [];
	const indent = "  ";

	// Header with account status
	const accountDot = state.accountActive
		? pc.green("\u25cf") + " " + pc.green("ACTIVE")
		: pc.yellow("\u25cb") + " " + pc.yellow("INACTIVE");
	lines.push("");
	lines.push(
		`${indent}${pc.bold("\u2601  CIRRUS")}  ${pc.dim("\u00b7")}  ${pc.cyan(config.hostname)}  ${pc.dim("\u00b7")}  ${pc.dim("v" + config.version)}`,
	);
	lines.push(
		`${indent}   ${pc.white("@" + config.handle)}  ${pc.dim("\u00b7")}  ${pc.dim(config.did)}  ${pc.dim("\u00b7")}  ${accountDot}`,
	);
	lines.push("");

	// Two-column layout: REPOSITORY | NETWORK
	const colWidth = Math.floor((cols - 6) / 2);

	// Column 1: Repository
	const col1: string[] = [pc.dim("REPOSITORY"), ""];
	if (state.collections.length === 0) {
		col1.push(pc.dim("No records"));
	} else {
		for (const c of state.collections) {
			const name = c.friendlyName.padEnd(16);
			const count = String(c.count).padStart(5);
			const more = c.hasMore ? "+" : " ";
			col1.push(`${name} ${pc.bold(count)}${more}`);
		}
	}

	// Column 2: Network
	const col2: string[] = [pc.dim("NETWORK"), ""];

	// Identity checks
	if (state.handleCheck) {
		const icon = state.handleCheck.ok ? pc.green("\u2713") : pc.red("\u2717");
		const methods =
			state.handleCheck.methods.length > 0
				? pc.dim(` ${state.handleCheck.methods.join(" ")}`)
				: "";
		col2.push(`${icon} handle${methods}`);
	} else {
		col2.push(pc.dim("\u25cb handle  checking\u2026"));
	}

	if (state.didCheck) {
		const icon = state.didCheck.ok ? pc.green("\u2713") : pc.red("\u2717");
		col2.push(`${icon} did document`);
	} else {
		col2.push(pc.dim("\u25cb did doc  checking\u2026"));
	}

	col2.push("");

	// Relay host status
	const relayStatusColors: Record<string, (s: string) => string> = {
		active: pc.green,
		idle: pc.yellow,
		offline: pc.red,
		throttled: pc.red,
		banned: pc.red,
	};
	const relayDotColors: Record<string, string> = {
		active: pc.green("\u25cf"),
		idle: pc.yellow("\u25cf"),
		offline: pc.red("\u25cf"),
		throttled: pc.red("\u25cf"),
		banned: pc.red("\u25cf"),
	};

	if (state.relayHostStatus.length > 0) {
		for (const relay of state.relayHostStatus) {
			const name = relay.relay
				.replace("https://relay1.", "")
				.replace(".bsky.network", "");
			const colorFn = relayStatusColors[relay.status] ?? pc.dim;
			const dot = relayDotColors[relay.status] ?? pc.dim("\u25cb");
			col2.push(`${dot} ${name} ${colorFn(relay.status)}`);
		}
	} else {
		col2.push(pc.dim("\u25cb relay  unknown"));
	}

	col2.push("");

	// Firehose subscribers
	const subDot = state.subscribers > 0 ? pc.green("\u25cf") : pc.dim("\u25cb");
	col2.push(
		`${subDot} ${pc.bold(String(state.subscribers))} subscriber${state.subscribers !== 1 ? "s" : ""}  ${pc.dim("seq:")} ${state.latestSeq != null ? state.latestSeq : pc.dim("\u2014")}`,
	);
	if (state.subscriberDetails.length > 0) {
		for (const sub of state.subscriberDetails.slice(0, 3)) {
			const ip = sub.ip ? shortenIP(sub.ip) : "";
			col2.push(
				pc.dim(`  ${relativeTime(sub.connectedAt)}  cursor: ${sub.cursor}  ${ip}`),
			);
		}
	}

	const columnLines = renderColumns([col1, col2], [colWidth, colWidth]);
	for (const line of columnLines) {
		lines.push(indent + line);
	}

	lines.push("");

	// Calculate remaining space for events + notifications + footer
	const usedLines = lines.length;
	const footerLines = 3; // blank + keybindings + blank
	const remaining = rows - usedLines - footerLines;
	const notifHeight = Math.max(3, Math.floor(remaining * 0.35));
	const eventsHeight = Math.max(3, remaining - notifHeight);

	// Events panel (full width)
	const wsStatusText = state.wsConnected
		? "\u25cf connected"
		: "\u25cb disconnected";
	const eventsPrefix = indent + "EVENTS ";
	const eventsSuffix = "  " + wsStatusText + "  ";
	const eventsSeparator = "\u2500".repeat(
		Math.max(0, cols - eventsPrefix.length - eventsSuffix.length),
	);
	const wsStatus = state.wsConnected
		? pc.green(wsStatusText)
		: pc.dim(wsStatusText);
	lines.push(`${indent}${pc.dim("EVENTS " + eventsSeparator)}  ${wsStatus}`);
	if (state.events.length === 0) {
		lines.push(`${indent}${pc.dim("Waiting for events\u2026")}`);
		for (let i = 1; i < eventsHeight - 1; i++) lines.push("");
	} else {
		const visibleEvents = state.events.slice(0, eventsHeight - 1);
		for (const ev of visibleEvents) {
			const actionColors: Record<string, (s: string) => string> = {
				create: pc.green,
				update: pc.yellow,
				delete: pc.red,
				identity: pc.cyan,
			};
			const actionColor = actionColors[ev.action] ?? pc.dim;
			const line = `${indent}${pc.dim(ev.time)}  ${pc.dim("#" + String(ev.seq).padStart(4))}  ${actionColor(ev.action.toUpperCase().padEnd(8))}  ${ev.path}`;
			lines.push(truncate(line, cols));
		}
		for (let i = visibleEvents.length; i < eventsHeight - 1; i++) {
			lines.push("");
		}
	}

	// Notifications panel
	const notifSeparator = "\u2500".repeat(
		Math.max(0, cols - visibleLength(indent + "NOTIFICATIONS ") - 2),
	);
	lines.push(`${indent}${pc.dim("NOTIFICATIONS " + notifSeparator)}`);
	if (state.notifications.length === 0) {
		lines.push(`${indent}${pc.dim("No notifications yet")}`);
		for (let i = 1; i < notifHeight - 1; i++) lines.push("");
	} else {
		const visibleNotifs = state.notifications.slice(0, notifHeight - 1);
		for (const n of visibleNotifs) {
			const readDim = n.isRead ? pc.dim : (s: string) => s;
			const line = `${indent}${pc.dim(n.time)}  ${n.icon}  ${readDim(n.author)} ${readDim(pc.dim(n.text))}`;
			lines.push(truncate(line, cols));
		}
		// Pad remaining
		for (let i = visibleNotifs.length; i < notifHeight - 1; i++) {
			lines.push("");
		}
	}

	// Footer with contextual keybindings
	lines.push("");
	const keys: string[] = [];
	if (!state.accountActive) {
		keys.push(`${pc.dim("[a]")} activate`);
	} else {
		keys.push(`${pc.dim("[r]")} crawl`);
		keys.push(`${pc.dim("[e]")} emit identity`);
	}
	keys.push(`${pc.dim("[q]")} quit`);
	let footer = `${indent}${keys.join(`  ${pc.dim("\u00b7")}  `)}`;
	if (state.statusMessage) {
		footer += `     ${pc.yellow(state.statusMessage)}`;
	}
	lines.push(footer);

	// Pad to fill terminal height, then write
	while (lines.length < rows) {
		lines.push("");
	}

	const output = lines
		.slice(0, rows)
		.map((l) => padRight(l, cols))
		.join("\n");
	process.stdout.write("\x1b[H" + output);
}

// ============================================
// Status message helper
// ============================================

function setStatusMessage(
	state: DashboardState,
	message: string,
	render: () => void,
	durationMs = 3000,
): void {
	if (state.statusMessageTimeout) clearTimeout(state.statusMessageTimeout);
	state.statusMessage = message;
	render();
	state.statusMessageTimeout = setTimeout(() => {
		state.statusMessage = null;
		render();
	}, durationMs);
}

// ============================================
// Command definition
// ============================================

export const dashboardCommand = defineCommand({
	meta: {
		name: "dashboard",
		description: "Live dashboard for PDS monitoring",
	},
	args: {
		dev: {
			type: "boolean",
			description: "Target local development server instead of production",
			default: false,
		},
	},
	async run({ args }) {
		const isDev = args.dev;

		// Load config
		const wranglerVars = getVars();
		const devVars = readDevVars();
		const config = { ...devVars, ...wranglerVars };

		let targetUrl: string;
		try {
			targetUrl = getTargetUrl(isDev, config.PDS_HOSTNAME);
		} catch (err) {
			console.error(
				pc.red("Error:"),
				err instanceof Error ? err.message : "Configuration error",
			);
			console.log(pc.dim("Run 'pds init' first to configure your PDS."));
			process.exit(1);
		}

		const authToken = config.AUTH_TOKEN;
		const handle = config.HANDLE ?? "";
		const did = config.DID ?? "";
		const pdsHostname = config.PDS_HOSTNAME ?? "";

		if (!authToken) {
			console.error(
				pc.red("Error:"),
				"No AUTH_TOKEN found. Run 'pds init' first.",
			);
			process.exit(1);
		}

		const client = new PDSClient(targetUrl, authToken);

		// Verify PDS is reachable
		const isHealthy = await client.healthCheck();
		if (!isHealthy) {
			console.error(pc.red("Error:"), `PDS not responding at ${targetUrl}`);
			process.exit(1);
		}

		// Initialize state
		const state = createInitialState();
		const dashConfig = {
			hostname: pdsHostname || targetUrl,
			handle,
			did,
			version: "0.10.6",
		};

		// Render function
		const render = () => renderDashboard(state, dashConfig);

		// Enter TUI mode
		enterAltScreen();
		hideCursor();
		clearScreen();

		// Cleanup function
		const intervals: ReturnType<typeof setInterval>[] = [];
		let firehose: { close: () => void } | null = null;
		let repoRefetchTimer: ReturnType<typeof setTimeout> | null = null;

		function cleanup(): void {
			for (const interval of intervals) clearInterval(interval);
			if (firehose) firehose.close();
			if (repoRefetchTimer) clearTimeout(repoRefetchTimer);
			if (state.statusMessageTimeout) clearTimeout(state.statusMessageTimeout);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
			showCursor();
			exitAltScreen();
		}

		process.on("SIGINT", () => {
			cleanup();
			process.exit(0);
		});
		process.on("SIGTERM", () => {
			cleanup();
			process.exit(0);
		});

		// Debounced repo refetch triggered by firehose events
		const scheduleRepoRefetch = () => {
			if (repoRefetchTimer) clearTimeout(repoRefetchTimer);
			repoRefetchTimer = setTimeout(() => {
				fetchRepo(client, did, state, render);
			}, 1000);
		};

		// Initial data fetch
		render();
		await Promise.all([
			fetchRepo(client, did, state, render),
			fetchFirehoseStatus(client, state, render),
			fetchAccountStatus(client, state, render),
			fetchNotifications(client, state, render),
			fetchIdentityChecks(client, handle, did, pdsHostname, state, render),
		]);
		// Relay host status can run in parallel too
		await fetchRelayHostStatus(client, pdsHostname, state, render);

		// Set up polling intervals
		intervals.push(
			setInterval(() => fetchRepo(client, did, state, render), 30000),
		);
		intervals.push(
			setInterval(
				() => fetchRelayHostStatus(client, pdsHostname, state, render),
				5000,
			),
		);
		intervals.push(
			setInterval(() => fetchFirehoseStatus(client, state, render), 10000),
		);
		intervals.push(
			setInterval(() => fetchNotifications(client, state, render), 15000),
		);
		intervals.push(
			setInterval(() => fetchAccountStatus(client, state, render), 30000),
		);
		intervals.push(
			setInterval(
				() =>
					fetchIdentityChecks(
						client,
						handle,
						did,
						pdsHostname,
						state,
						render,
					),
				15000,
			),
		);

		// Connect to firehose for real-time events
		firehose = connectFirehose(targetUrl, state, render, scheduleRepoRefetch);

		// Handle resize
		process.stdout.on("resize", render);

		// Keypress handling
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.setEncoding("utf8");

			let activateConfirmTimeout: ReturnType<typeof setTimeout> | null = null;
			let awaitingActivateConfirm = false;

			process.stdin.on("data", async (key: string) => {
				// Ctrl+C
				if (key === "\x03") {
					cleanup();
					process.exit(0);
				}

				// q = quit
				if (key === "q" || key === "Q") {
					cleanup();
					process.exit(0);
				}

				// a = activate (only when inactive, with inline confirmation)
				if (key === "a" || key === "A") {
					if (state.accountActive) return;
					if (awaitingActivateConfirm) {
						awaitingActivateConfirm = false;
						if (activateConfirmTimeout)
							clearTimeout(activateConfirmTimeout);
						setStatusMessage(state, "Activating\u2026", render, 10000);
						try {
							await client.activateAccount();
							state.accountActive = true;
							setStatusMessage(
								state,
								pc.green("\u2713 Account activated"),
								render,
								5000,
							);
						} catch (err) {
							setStatusMessage(
								state,
								pc.red(
									`\u2717 ${err instanceof Error ? err.message : "Activation failed"}`,
								),
								render,
								5000,
							);
						}
					} else {
						awaitingActivateConfirm = true;
						setStatusMessage(
							state,
							"Press [a] again to activate",
							render,
							3000,
						);
						activateConfirmTimeout = setTimeout(() => {
							awaitingActivateConfirm = false;
							state.statusMessage = null;
							render();
						}, 3000);
					}
					return;
				}

				// r = request crawl (only when active)
				if (key === "r" || key === "R") {
					if (!state.accountActive) return;
					if (!pdsHostname || isDev) {
						setStatusMessage(
							state,
							pc.yellow("No PDS hostname configured"),
							render,
						);
						return;
					}
					setStatusMessage(state, "Requesting crawl\u2026", render, 10000);
					const ok = await client.requestCrawl(pdsHostname);
					setStatusMessage(
						state,
						ok
							? pc.green("\u2713 Crawl requested")
							: pc.red("\u2717 Crawl request failed"),
						render,
					);
					return;
				}

				// e = emit identity (only when active)
				if (key === "e" || key === "E") {
					if (!state.accountActive) return;
					setStatusMessage(state, "Emitting identity\u2026", render, 10000);
					try {
						const result = await client.emitIdentity();
						setStatusMessage(
							state,
							pc.green(`\u2713 Identity emitted (seq: ${result.seq})`),
							render,
						);
					} catch (err) {
						setStatusMessage(
							state,
							pc.red(
								`\u2717 ${err instanceof Error ? err.message : "Failed"}`,
							),
							render,
						);
					}
					return;
				}
			});
		}
	},
});
