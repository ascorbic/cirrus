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

interface FirehoseCommit {
	seq: number;
	ops: Array<{ action: string; path: string }>;
}

function parseFirehoseMessage(data: Uint8Array): FirehoseCommit | null {
	try {
		const decoded = [...decodeAll(data)];
		if (decoded.length !== 2) return null;
		const header = decoded[0] as { op?: number; t?: string };
		const body = decoded[1] as {
			seq?: number;
			ops?: Array<{ action: string; path: string }>;
		};
		if (!header || header.op !== 1 || header.t !== "#commit") return null;
		if (!body || typeof body.seq !== "number") return null;
		return {
			seq: body.seq,
			ops: (body.ops ?? []).map((op) => ({
				action: op.action,
				path: op.path,
			})),
		};
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
};

function friendlyName(collection: string): string {
	return (
		COLLECTION_NAMES[collection] ?? collection.split(".").pop() ?? collection
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
	syncStatus: "checking" | "synced" | "behind" | "unknown" | "error";
	relayRev: string | null;
	pdsRev: string | null;
	subscribers: number;
	latestSeq: number | null;
	subscriberDetails: Array<{ connectedAt: number; cursor: number }>;
	events: DashboardEvent[];
	notifications: Notification[];
	accountActive: boolean;
	wsConnected: boolean;
	statusMessage: string | null;
	statusMessageTimeout: ReturnType<typeof setTimeout> | null;
}

const MAX_EVENTS = 100;
const MAX_NOTIFICATIONS = 50;

function createInitialState(): DashboardState {
	return {
		collections: [],
		syncStatus: "checking",
		relayRev: null,
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

		state.collections = results;
		render();
	} catch {
		// Silently retry on next interval
	}
}

async function fetchRelaySync(
	did: string,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	if (!state.pdsRev) return;
	try {
		const res = await fetch(
			`https://bsky.network/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`,
		);
		if (res.status === 404) {
			state.syncStatus = "unknown";
		} else if (res.ok) {
			const data = (await res.json()) as { rev: string };
			state.syncStatus = data.rev === state.pdsRev ? "synced" : "behind";
			state.relayRev = data.rev;
		} else {
			state.syncStatus = "error";
		}
		render();
	} catch {
		state.syncStatus = "error";
		render();
	}
}

async function fetchSubscribers(
	client: PDSClient,
	state: DashboardState,
	render: () => void,
): Promise<void> {
	try {
		const data = await client.getSubscribers();
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

// ============================================
// WebSocket firehose connection
// ============================================

function connectFirehose(
	targetUrl: string,
	state: DashboardState,
	render: () => void,
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
				const commit = parseFirehoseMessage(
					new Uint8Array(e.data as ArrayBuffer),
				);
				if (!commit) return;
				const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
				for (const op of commit.ops) {
					state.events.unshift({
						time,
						seq: commit.seq,
						action: op.action,
						path: op.path,
					});
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

	// Header
	lines.push("");
	lines.push(
		`${indent}${pc.bold("\u2601  CIRRUS")}  ${pc.dim("\u00b7")}  ${pc.cyan(config.hostname)}  ${pc.dim("\u00b7")}  ${pc.dim("v" + config.version)}`,
	);
	lines.push(
		`${indent}   ${pc.white("@" + config.handle)}  ${pc.dim("\u00b7")}  ${pc.dim(config.did)}`,
	);
	lines.push("");

	// Three-column panels
	const colWidth = Math.floor((cols - 6) / 3);

	// Column 1: Repository
	const col1: string[] = [pc.dim("REPOSITORY"), ""];
	if (state.collections.length === 0) {
		col1.push(pc.dim("Loading\u2026"));
	} else {
		for (const c of state.collections) {
			const name = c.friendlyName.padEnd(16);
			const count = String(c.count).padStart(5);
			const more = c.hasMore ? "+" : " ";
			col1.push(`${name} ${pc.bold(count)}${more}`);
		}
	}

	// Column 2: Federation
	const col2: string[] = [pc.dim("FEDERATION"), ""];
	col2.push(pc.dim("bsky.network"));
	const statusColors: Record<string, (s: string) => string> = {
		synced: pc.green,
		behind: pc.yellow,
		error: pc.red,
		checking: pc.dim,
		unknown: pc.dim,
	};
	const dotColors: Record<string, string> = {
		synced: pc.green("\u25cf"),
		behind: pc.yellow("\u25cf"),
		error: pc.red("\u25cf"),
		checking: pc.dim("\u25cb"),
		unknown: pc.dim("\u25cb"),
	};
	const colorFn = statusColors[state.syncStatus] ?? pc.dim;
	col2.push(
		`${dotColors[state.syncStatus] ?? pc.dim("\u25cb")} ${colorFn(state.syncStatus.toUpperCase())}`,
	);
	if (state.relayRev) {
		col2.push(pc.dim(`rev: ${state.relayRev.slice(0, 12)}`));
	}

	// Column 3: Firehose
	const col3: string[] = [pc.dim("FIREHOSE"), ""];
	const subDot = state.subscribers > 0 ? pc.green("\u25cf") : pc.dim("\u25cb");
	col3.push(
		`${subDot} ${pc.bold(String(state.subscribers))} subscriber${state.subscribers !== 1 ? "s" : ""}`,
	);
	col3.push(
		pc.dim(`seq: ${state.latestSeq != null ? state.latestSeq : "\u2014"}`),
	);
	if (state.subscriberDetails.length > 0) {
		col3.push("");
		for (const sub of state.subscriberDetails.slice(0, 5)) {
			col3.push(
				pc.dim(`${relativeTime(sub.connectedAt)}  cursor: ${sub.cursor}`),
			);
		}
	}

	const columnLines = renderColumns(
		[col1, col2, col3],
		[colWidth, colWidth, colWidth],
	);
	for (const line of columnLines) {
		lines.push(indent + line);
	}

	lines.push("");

	// Calculate remaining space for notifications + events + footer
	const usedLines = lines.length;
	const footerLines = 3; // blank + keybindings + blank
	const remaining = rows - usedLines - footerLines;
	const notifHeight = Math.max(3, Math.floor(remaining * 0.4));
	const eventsHeight = Math.max(3, remaining - notifHeight);

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

	lines.push("");

	// Events panel
	const eventsSeparator = "\u2500".repeat(
		Math.max(0, cols - visibleLength(indent + "EVENTS ") - 2),
	);
	const wsStatus = state.wsConnected
		? pc.green("\u25cf connected")
		: pc.dim("\u25cb disconnected");
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
			};
			const actionColor = actionColors[ev.action] ?? pc.dim;
			const line = `${indent}${pc.dim(ev.time)}  ${pc.dim("#" + String(ev.seq).padStart(4))}  ${actionColor(ev.action.toUpperCase().padEnd(7))}  ${ev.path}`;
			lines.push(truncate(line, cols));
		}
		for (let i = visibleEvents.length; i < eventsHeight - 1; i++) {
			lines.push("");
		}
	}

	// Footer
	lines.push("");
	const accountStatus = state.accountActive
		? pc.green("\u25cf active")
		: pc.yellow("\u25cb deactivated");
	let footer = `${indent}${pc.dim("[a]")} activate  ${pc.dim("\u00b7")}  ${pc.dim("[r]")} crawl  ${pc.dim("\u00b7")}  ${pc.dim("[e]")} emit identity  ${pc.dim("\u00b7")}  ${pc.dim("[q]")} quit`;
	// Add status message or account status to the right
	if (state.statusMessage) {
		footer += `     ${pc.yellow(state.statusMessage)}`;
	} else {
		footer += `     ${accountStatus}`;
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
			hostname: config.PDS_HOSTNAME ?? targetUrl,
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

		function cleanup(): void {
			for (const interval of intervals) clearInterval(interval);
			if (firehose) firehose.close();
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

		// Initial data fetch
		render();
		await Promise.all([
			fetchRepo(client, did, state, render),
			fetchSubscribers(client, state, render),
			fetchAccountStatus(client, state, render),
			fetchNotifications(client, state, render),
		]);
		// Start relay sync after repo data is available (needs pdsRev)
		await fetchRelaySync(did, state, render);

		// Set up polling intervals
		intervals.push(
			setInterval(() => fetchRepo(client, did, state, render), 30000),
		);
		intervals.push(setInterval(() => fetchRelaySync(did, state, render), 5000));
		intervals.push(
			setInterval(() => fetchSubscribers(client, state, render), 10000),
		);
		intervals.push(
			setInterval(() => fetchNotifications(client, state, render), 15000),
		);
		intervals.push(
			setInterval(() => fetchAccountStatus(client, state, render), 30000),
		);

		// Connect to firehose for real-time events
		firehose = connectFirehose(targetUrl, state, render);

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

				// a = activate (with inline confirmation)
				if (key === "a" || key === "A") {
					if (awaitingActivateConfirm) {
						awaitingActivateConfirm = false;
						if (activateConfirmTimeout) clearTimeout(activateConfirmTimeout);
						setStatusMessage(state, "Activating\u2026", render, 10000);
						try {
							await client.activateAccount();
							state.accountActive = true;
							const pdsHostname = config.PDS_HOSTNAME;
							if (pdsHostname && !isDev) {
								await client.requestCrawl(pdsHostname);
							}
							try {
								await client.emitIdentity();
							} catch {
								// Non-critical
							}
							setStatusMessage(
								state,
								pc.green("\u2713 Activated! Crawl requested."),
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

				// r = request crawl
				if (key === "r" || key === "R") {
					const pdsHostname = config.PDS_HOSTNAME;
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

				// e = emit identity
				if (key === "e" || key === "E") {
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
							pc.red(`\u2717 ${err instanceof Error ? err.message : "Failed"}`),
							render,
						);
					}
					return;
				}
			});
		}
	},
});
