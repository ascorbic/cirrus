// Public API
export { AccountDurableObject } from "./account-do";
export type { PDSEnv } from "./types";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { env as _env } from "cloudflare:workers";
import { Secp256k1Keypair } from "@atproto/crypto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { requireAuth } from "./middleware/auth";
import { DidResolver } from "./did-resolver";
import { WorkersDidCache } from "./did-cache";
import { handleXrpcProxy } from "./xrpc-proxy";
import { createOAuthApp } from "./oauth";
import * as sync from "./xrpc/sync";
import * as repo from "./xrpc/repo";
import * as server from "./xrpc/server";
import * as passkey from "./passkey";
import {
	renderPasskeyRegistrationPage,
	renderPasskeyErrorPage,
	getPasskeyUiCsp,
	PASSKEY_ERROR_CSP,
} from "./passkey-ui";
import type { PDSEnv } from "./types";

import { version } from "../package.json" with { type: "json" };

// Cast env to PDSEnv for type safety
const env = _env as PDSEnv;

// Validate required environment variables at module load
const required = [
	"DID",
	"HANDLE",
	"PDS_HOSTNAME",
	"AUTH_TOKEN",
	"SIGNING_KEY",
	"SIGNING_KEY_PUBLIC",
	"JWT_SECRET",
	"PASSWORD_HASH",
] as const;

for (const key of required) {
	if (!env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

// Validate DID and handle formats
if (!isDid(env.DID)) {
	throw new Error(`Invalid DID format: ${env.DID}`);
}
if (!isHandle(env.HANDLE)) {
	throw new Error(`Invalid handle format: ${env.HANDLE}`);
}

const didResolver = new DidResolver({
	didCache: new WorkersDidCache(),
	timeout: 3000, // 3 second timeout for DID resolution
	plcUrl: "https://plc.directory",
});

// Lazy-loaded keypair for service auth
let keypairPromise: Promise<Secp256k1Keypair> | null = null;
function getKeypair(): Promise<Secp256k1Keypair> {
	if (!keypairPromise) {
		keypairPromise = Secp256k1Keypair.import(env.SIGNING_KEY);
	}
	return keypairPromise;
}

const app = new Hono<{ Bindings: PDSEnv }>();

// CORS middleware for all routes
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["*"],
		exposeHeaders: ["Content-Type"],
		maxAge: 86400,
	}),
);

// Helper to get Account DO stub
function getAccountDO(env: PDSEnv) {
	const id = env.ACCOUNT.idFromName("account");
	return env.ACCOUNT.get(id);
}

// DID document for did:web resolution
app.get("/.well-known/did.json", (c) => {
	const didDocument = {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: c.env.DID,
		alsoKnownAs: [`at://${c.env.HANDLE}`],
		verificationMethod: [
			{
				id: `${c.env.DID}#atproto`,
				type: "Multikey",
				controller: c.env.DID,
				publicKeyMultibase: c.env.SIGNING_KEY_PUBLIC,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: `https://${c.env.PDS_HOSTNAME}`,
			},
		],
	};
	return c.json(didDocument);
});

// Handle verification for AT Protocol
// Only served if handle matches PDS hostname
app.get("/.well-known/atproto-did", (c) => {
	if (c.env.HANDLE !== c.env.PDS_HOSTNAME) {
		return c.notFound();
	}
	return new Response(c.env.DID, {
		headers: { "Content-Type": "text/plain" },
	});
});

// Health check - AT Protocol standard path
app.get("/xrpc/_health", async (c) => {
	try {
		const accountDO = getAccountDO(c.env);
		await accountDO.rpcHealthCheck();
		return c.json({ status: "ok", version });
	} catch {
		return c.json({ status: "unhealthy", version }, 503);
	}
});

// Homepage
app.get("/", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>☁️</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
	background: #f0f0f0;
	color: #000;
	padding: 2rem;
}
.cloud { font-size: clamp(4rem, 15vw, 10rem); line-height: 1; }
.name { font-size: clamp(1.5rem, 5vw, 3rem); font-weight: 700; letter-spacing: 0.2em; margin: 1rem 0; }
.what { font-size: clamp(0.8rem, 2vw, 1rem); color: #666; max-width: 300px; text-align: center; }
.handle { font-size: clamp(0.9rem, 2.5vw, 1.2rem); margin-top: 2rem; padding: 0.5rem 1rem; border: 2px solid #000; }
:is(.handle, .name) a { color: inherit; text-decoration: none; }
:is(.handle, .name) a:hover { text-decoration: underline; }
.version { position: fixed; bottom: 1rem; right: 1rem; font-size: 0.7rem; color: #999; }
</style>
</head>
<body>
<div class="cloud">☁️</div>
<div class="name"><a href="https://github.com/ascorbic/cirrus">CIRRUS</a></div>
<div class="what">a personal data server for the atmosphere</div>
<div class="handle"><a href="https://bsky.app/profile/${c.env.HANDLE}" target="_blank">@${c.env.HANDLE}</a></div>
<div class="version">v${version}</div>
</body>
</html>`;
	return c.html(html);
});

// Sync endpoints (federation)
app.get("/xrpc/com.atproto.sync.getRepo", (c) =>
	sync.getRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getRepoStatus", (c) =>
	sync.getRepoStatus(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getBlocks", (c) =>
	sync.getBlocks(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getBlob", (c) =>
	sync.getBlob(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.listRepos", (c) =>
	sync.listRepos(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.listBlobs", (c) =>
	sync.listBlobs(c, getAccountDO(c.env)),
);

// WebSocket firehose
app.get("/xrpc/com.atproto.sync.subscribeRepos", async (c) => {
	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		return c.json(
			{ error: "InvalidRequest", message: "Expected WebSocket upgrade" },
			400,
		);
	}

	// Use fetch() instead of RPC to avoid WebSocket serialization error
	const accountDO = getAccountDO(c.env);
	return accountDO.fetch(c.req.raw);
});

// Repository operations - handle local repo directly, proxy foreign DIDs to AppView
app.use("/xrpc/com.atproto.repo.describeRepo", async (c, next) => {
	const requestedRepo = c.req.query("repo");
	if (!requestedRepo || requestedRepo === c.env.DID) {
		return repo.describeRepo(c, getAccountDO(c.env));
	}
	await next();
});

app.use("/xrpc/com.atproto.repo.getRecord", async (c, next) => {
	const requestedRepo = c.req.query("repo");
	if (!requestedRepo || requestedRepo === c.env.DID) {
		return repo.getRecord(c, getAccountDO(c.env));
	}
	await next();
});

app.use("/xrpc/com.atproto.repo.listRecords", async (c, next) => {
	const requestedRepo = c.req.query("repo");
	if (!requestedRepo || requestedRepo === c.env.DID) {
		return repo.listRecords(c, getAccountDO(c.env));
	}
	await next();
});

// Write operations require authentication
app.post("/xrpc/com.atproto.repo.createRecord", requireAuth, (c) =>
	repo.createRecord(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.deleteRecord", requireAuth, (c) =>
	repo.deleteRecord(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.uploadBlob", requireAuth, (c) =>
	repo.uploadBlob(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.applyWrites", requireAuth, (c) =>
	repo.applyWrites(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.putRecord", requireAuth, (c) =>
	repo.putRecord(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.importRepo", requireAuth, (c) =>
	repo.importRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.repo.listMissingBlobs", requireAuth, (c) =>
	repo.listMissingBlobs(c, getAccountDO(c.env)),
);

// Server identity
app.get("/xrpc/com.atproto.server.describeServer", server.describeServer);

// Handle resolution - return our DID for our handle, let others fall through to proxy
app.use("/xrpc/com.atproto.identity.resolveHandle", async (c, next) => {
	const handle = c.req.query("handle");
	if (handle === c.env.HANDLE) {
		return c.json({ did: c.env.DID });
	}
	await next();
});

// Session management
app.post("/xrpc/com.atproto.server.createSession", server.createSession);
app.post("/xrpc/com.atproto.server.refreshSession", server.refreshSession);
app.get("/xrpc/com.atproto.server.getSession", server.getSession);
app.post("/xrpc/com.atproto.server.deleteSession", server.deleteSession);

// Account lifecycle
app.get("/xrpc/com.atproto.server.getAccountStatus", requireAuth, (c) =>
	server.getAccountStatus(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.server.activateAccount", requireAuth, (c) =>
	server.activateAccount(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.server.deactivateAccount", requireAuth, (c) =>
	server.deactivateAccount(c, getAccountDO(c.env)),
);
app.post("/xrpc/gg.mk.experimental.resetMigration", requireAuth, (c) =>
	server.resetMigration(c, getAccountDO(c.env)),
);

// Service auth - used by clients to get JWTs for external services (video, etc.)
app.get(
	"/xrpc/com.atproto.server.getServiceAuth",
	requireAuth,
	server.getServiceAuth,
);

// Actor preferences
app.get("/xrpc/app.bsky.actor.getPreferences", requireAuth, async (c) => {
	const accountDO = getAccountDO(c.env);
	const result = await accountDO.rpcGetPreferences();
	return c.json(result);
});
app.post("/xrpc/app.bsky.actor.putPreferences", requireAuth, async (c) => {
	const body = await c.req.json<{ preferences: unknown[] }>();
	const accountDO = getAccountDO(c.env);
	await accountDO.rpcPutPreferences(body.preferences);
	return c.json({});
});

// Age assurance (stub - self-hosted users are pre-verified)
app.get("/xrpc/app.bsky.ageassurance.getState", requireAuth, (c) => {
	return c.json({
		state: {
			status: "assured",
			access: "full",
			lastInitiatedAt: new Date().toISOString(),
		},
		metadata: {
			accountCreatedAt: new Date().toISOString(),
		},
	});
});

// Emit identity event to refresh handle verification with relays
app.post("/xrpc/gg.mk.experimental.emitIdentityEvent", requireAuth, async (c) => {
	const accountDO = getAccountDO(c.env);
	const result = await accountDO.rpcEmitIdentityEvent(c.env.HANDLE);
	return c.json(result);
});

// Firehose status (authenticated)
app.get(
	"/xrpc/gg.mk.experimental.getFirehoseStatus",
	requireAuth,
	async (c) => {
		const accountDO = getAccountDO(c.env);
		return c.json(await accountDO.rpcGetFirehoseStatus());
	},
);

// ============================================
// Passkey Routes
// ============================================

// Initialize passkey registration (authenticated)
app.post("/passkey/init", requireAuth, async (c) => {
	const accountDO = getAccountDO(c.env);
	const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
	try {
		const result = await passkey.initPasskeyRegistration(
			accountDO,
			c.env.PDS_HOSTNAME,
			c.env.DID,
			body.name,
		);
		return c.json(result);
	} catch (err) {
		console.error("Passkey init error:", err);
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: "PasskeyInitFailed", message }, 500);
	}
});

// Passkey registration page (GET - renders UI)
app.get("/passkey/register", async (c) => {
	const token = c.req.query("token");
	if (!token) {
		return c.html(
			renderPasskeyErrorPage("missing_token", "No registration token provided."),
			400,
			{ "Content-Security-Policy": PASSKEY_ERROR_CSP },
		);
	}

	const accountDO = getAccountDO(c.env);
	const options = await passkey.getRegistrationOptions(
		accountDO,
		c.env.PDS_HOSTNAME,
		c.env.DID,
		token,
	);

	if (!options) {
		return c.html(
			renderPasskeyErrorPage("invalid_token", "Invalid or expired registration token."),
			400,
			{ "Content-Security-Policy": PASSKEY_ERROR_CSP },
		);
	}

	const csp = await getPasskeyUiCsp();
	return c.html(
		renderPasskeyRegistrationPage({
			options,
			token,
			handle: c.env.HANDLE,
		}),
		200,
		{ "Content-Security-Policy": csp },
	);
});

// Complete passkey registration (POST - receives WebAuthn response)
app.post("/passkey/register", async (c) => {
	const body = await c.req.json<{
		token: string;
		response: any;
	}>();

	if (!body.token || !body.response) {
		return c.json({ success: false, error: "Missing token or response" }, 400);
	}

	const accountDO = getAccountDO(c.env);
	// Name comes from the token (set during init)
	const result = await passkey.completePasskeyRegistration(
		accountDO,
		c.env.PDS_HOSTNAME,
		body.token,
		body.response,
	);

	if (result.success) {
		return c.json({ success: true });
	} else {
		return c.json({ success: false, error: result.error }, 400);
	}
});

// List passkeys (authenticated)
app.get("/passkey/list", requireAuth, async (c) => {
	const accountDO = getAccountDO(c.env);
	const passkeys = await passkey.listPasskeys(accountDO);
	return c.json({ passkeys });
});

// Delete passkey (authenticated)
app.post("/passkey/delete", requireAuth, async (c) => {
	const body = await c.req.json<{ id: string }>();
	if (!body.id) {
		return c.json({ success: false, error: "Missing passkey ID" }, 400);
	}

	const accountDO = getAccountDO(c.env);
	const deleted = await passkey.deletePasskey(accountDO, body.id);
	return c.json({ success: deleted });
});

// OAuth 2.1 endpoints for "Login with Bluesky"
const oauthApp = createOAuthApp(getAccountDO);
app.route("/", oauthApp);

// Proxy unhandled XRPC requests to services specified via atproto-proxy header
// or fall back to Bluesky services for backward compatibility
app.all("/xrpc/*", (c) => handleXrpcProxy(c, didResolver, getKeypair));

export default app;
