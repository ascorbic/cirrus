/**
 * Multi-tenant PDS Entry Point for fid.is
 *
 * This is the worker entry point for the Farcaster-to-ATProto bridge.
 * It handles multiple users with:
 * - Wildcard subdomain routing (NNN.fid.is)
 * - DID-based DO routing (deterministic from DID)
 * - Dynamic DID document generation
 * - Farcaster Quick Auth for authentication
 */

// Public API exports
export { AccountDurableObject } from "./account-do";
export type { PDSEnv, DataLocation } from "./types";
export {
	registerUser,
	deleteUser,
	getUserByFid,
	getUserByNumber,
	getUserCount,
	isAllowed,
	isWaitlisted,
	joinWaitlist,
} from "./user-registry";
export type { UserRegistration } from "./user-registry";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth } from "./middleware/auth";
import { DidResolver } from "./did-resolver";
import { WorkersDidCache } from "./did-cache";
import { handleXrpcProxy } from "./xrpc-proxy";
import { getSigningKeypair } from "./service-auth";
import { createOAuthApp, getProviderForRequest } from "./oauth";
import * as sync from "./xrpc/sync";
import * as repo from "./xrpc/repo";
import * as server from "./xrpc/server";
import * as fidAccount from "./xrpc/fid-account";
import * as fidSettings from "./xrpc/fid-settings";
import * as fidPasskeys from "./xrpc/fid-passkeys";
import {
	hostnameToFid,
	fidToDid,
	fidToHandle,
	fidToPdsHostname,
} from "./farcaster-auth";
import type { PDSEnv, AppEnv } from "./types";
import type { AccountDurableObject } from "./account-do";

import { env } from "cloudflare:workers";
import { version } from "../package.json" with { type: "json" };

// Validate required environment variables at module load
const pdsEnv = env as unknown as PDSEnv;
const required = ["WEBFID_DOMAIN", "JWT_SECRET"] as const;

for (const key of required) {
	if (!pdsEnv[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

const didResolver = new DidResolver({
	didCache: new WorkersDidCache(),
	timeout: 3000,
	plcUrl: "https://plc.directory",
});

const app = new Hono<AppEnv>();

// CORS middleware for all routes (skip WebSocket upgrades — modifying the 101
// response loses the webSocket property and causes the Workers runtime to 500)
const corsMiddleware = cors({
	origin: "*",
	allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	allowHeaders: ["*"],
	exposeHeaders: ["Content-Type"],
	maxAge: 86400,
});
app.use("*", async (c, next) => {
	if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
		await next();
		return;
	}
	return corsMiddleware(c, next);
});

/**
 * Get Account DO stub using DID-based deterministic routing.
 * The DID is used as the DO name for consistent routing.
 */
function getAccountDO(
	env: PDSEnv,
	did: string,
): DurableObjectStub<AccountDurableObject> {
	const location = env.DATA_LOCATION;

	// "eu" is a jurisdiction (hard guarantee), everything else is a hint (best-effort)
	if (location === "eu") {
		const namespace = env.ACCOUNT.jurisdiction("eu");
		return namespace.get(namespace.idFromName(did));
	}

	// Location hints (or "auto"/undefined = no constraint)
	const id = env.ACCOUNT.idFromName(did);
	if (location && location !== "auto") {
		return env.ACCOUNT.get(id, { locationHint: location });
	}

	return env.ACCOUNT.get(id);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract FID from subdomain hostname.
 * Used for well-known endpoints served on NNN.{domain}.
 */
function extractFidFromSubdomain(hostname: string, domain: string): string | null {
	return hostnameToFid(hostname, domain);
}

/**
 * Check if a DID is a WebFID DID that we can route to.
 */
function isWebFidDid(did: string, domain: string): boolean {
	const regex = new RegExp(`^did:web:\\d+\\.${escapeRegex(domain)}$`);
	return regex.test(did);
}

// ============================================
// OAuth 2.1 Endpoints (served on NNN.fid.is per-user subdomains)
// ============================================

// Mount OAuth routes - handles /.well-known/oauth-* and /oauth/*
const oauthApp = createOAuthApp(getAccountDO);
app.route("/", oauthApp);

// ============================================
// Well-Known Endpoints (served on NNN.fid.is)
// ============================================

// Handle resolution: NNN.{domain}/.well-known/atproto-did -> did:web:NNN.{domain}
app.get("/.well-known/atproto-did", async (c) => {
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const fid = extractFidFromSubdomain(hostname, domain);

	if (!fid) {
		return c.text("Invalid hostname", 400);
	}

	const did = fidToDid(fid, domain);
	const accountDO = getAccountDO(c.env, did);
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.text("Not Found", 404);
	}

	return new Response(did, {
		headers: { "Content-Type": "text/plain" },
	});
});

// DID document: NNN.{domain}/.well-known/did.json
app.get("/.well-known/did.json", async (c) => {
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const fid = extractFidFromSubdomain(hostname, domain);

	if (!fid) {
		return c.json({ error: "InvalidHostname", message: "Invalid hostname" }, 400);
	}

	const did = fidToDid(fid, domain);

	// Fetch the identity from the account's DO (route by DID)
	const accountDO = getAccountDO(c.env, did);
	const identity = await accountDO.rpcGetAtprotoIdentity();

	if (!identity) {
		return c.json(
			{ error: "AccountNotFound", message: "Account not found" },
			404,
		);
	}

	const handle = identity.handle;
	const publicKey = identity.signingKeyPublic;

	// Check for custom PDS URL and verification key
	const [customPdsUrl, customVerificationKey] = await Promise.all([
		accountDO.rpcGetCustomPdsUrl(),
		accountDO.rpcGetCustomVerificationKey(),
	]);
	const serviceEndpoint = customPdsUrl || `https://${fidToPdsHostname(fid, domain)}`;
	const verificationKey = customVerificationKey || publicKey;

	const didDocument = {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: did,
		alsoKnownAs: [`at://${handle}`],
		verificationMethod: [
			{
				id: `${did}#atproto`,
				type: "Multikey",
				controller: did,
				publicKeyMultibase: verificationKey,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint,
			},
		],
	};
	return c.json(didDocument);
});

// ============================================
// XRPC Endpoints (served on NNN.fid.is per-user subdomains)
// ============================================

// DPoP auth middleware — verifies OAuth DPoP tokens and sets `did` in context
// so that requireAuth (which only handles Bearer JWTs) can use it as a fallback.
app.use("/xrpc/*", async (c, next) => {
	// Skip DPoP verification for WebSocket upgrades (firehose is unauthenticated)
	if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
		await next();
		return;
	}
	const auth = c.req.header("Authorization");
	if (auth?.startsWith("DPoP ")) {
		try {
			const provider = getProviderForRequest(c.req.raw, getAccountDO, c.env);
			if (provider) {
				const tokenData = await provider.verifyAccessToken(c.req.raw);
				if (tokenData?.sub) {
					c.set("did", tokenData.sub);
				}
			}
		} catch {
			// DPoP verification failed — requireAuth will return 401
		}
	}
	await next();
});

// Health check
app.get("/xrpc/_health", (c) => {
	return c.json({ status: "ok", version });
});

// Homepage
app.get("/", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fid.is</title>
<meta name="description" content="Your Farcaster identity on Bluesky. One account. Two networks.">
<meta property="og:title" content="fid.is">
<meta property="og:description" content="Your Farcaster identity on Bluesky. One account. Two networks.">
<meta property="og:type" content="website">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	background: #0a0a0a;
	color: #fafafa;
	padding: 2rem;
}
.brand {
	font-size: clamp(3rem, 12vw, 6rem);
	font-weight: 700;
	line-height: 1;
	background: linear-gradient(135deg, #7c6aef, #38bdf8);
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	background-clip: text;
}
.tagline {
	font-size: clamp(1rem, 3vw, 1.25rem);
	color: #a1a1aa;
	margin-top: 1rem;
	text-align: center;
}
.cta {
	margin-top: 2rem;
	display: inline-block;
	padding: 0.75rem 2rem;
	background: #3b82f6;
	color: #fff;
	text-decoration: none;
	border-radius: 8px;
	font-size: 1rem;
	font-weight: 500;
	transition: background 0.15s;
}
.cta:hover { background: #2563eb; }
.sub {
	margin-top: 1.5rem;
	font-size: 0.875rem;
	color: #52525b;
	text-align: center;
	max-width: 400px;
	line-height: 1.5;
}
.version { position: fixed; bottom: 1rem; right: 1rem; font-size: 0.7rem; color: #3f3f46; }
</style>
</head>
<body>
<div class="brand">fid.is</div>
<div class="tagline">Your Farcaster identity on Bluesky</div>
<a class="cta" href="https://my.fid.is">Get Started</a>
<div class="sub">One account. Two networks. Use your Farcaster identity to post on Bluesky. No new account, no new password.</div>
<div class="version">v${version}</div>
</body>
</html>`;
	return c.html(html);
});

// Server description
app.get("/xrpc/com.atproto.server.describeServer", (c) => {
	// In per-user subdomain mode, derive DID from hostname
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const fid = extractFidFromSubdomain(hostname, domain);

	if (fid === null) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid hostname" },
			400,
		);
	}

	return c.json({
		did: fidToDid(fid, domain),
		availableUserDomains: [domain],
		inviteCodeRequired: false,
	});
});

// ============================================
// FID Account Management Endpoints
// ============================================

// Create account with Farcaster auth
app.post("/xrpc/is.fid.account.create", (c) =>
	fidAccount.createAccount(c, getAccountDO),
);

// Delete account (requires auth)
app.post("/xrpc/is.fid.account.delete", requireAuth, (c: any) =>
	fidAccount.deleteAccount(c, getAccountDO),
);

// Sync relay seq (requires auth) — manual debug tool
app.post("/xrpc/is.fid.account.syncRelaySeq", requireAuth, (c: any) =>
	fidAccount.syncRelaySeq(c, getAccountDO),
);

// Login with Farcaster auth
app.post("/xrpc/is.fid.auth.login", (c) =>
	fidAccount.loginWithFarcaster(c, getAccountDO),
);

// Login with Sign In With Farcaster (browser-based) — login only
app.post("/xrpc/is.fid.auth.siwf", (c) =>
	fidAccount.loginWithSiwf(c, getAccountDO),
);

// Check account status by FID (lightweight, always 200)
app.get("/xrpc/is.fid.account.status", (c) =>
	fidAccount.getAccountStatus(c, getAccountDO),
);

// Create account with Sign In With Farcaster (browser-based)
app.post("/xrpc/is.fid.account.createSiwf", (c) =>
	fidAccount.createAccountSiwf(c, getAccountDO),
);

// Join the waitlist (when allowlist is enabled)
app.post("/xrpc/is.fid.waitlist.join", (c) =>
	fidAccount.joinWaitlist(c, getAccountDO),
);

// ============================================
// FID Settings Endpoints
// ============================================

// Get PDS URL configuration
app.get(
	"/xrpc/is.fid.settings.getPdsUrl",
	requireAuth,
	(c: any) => fidSettings.getPdsUrl(c, getAccountDO(c.env, c.get("did"))),
);

// Set custom PDS URL
app.post(
	"/xrpc/is.fid.settings.setPdsUrl",
	requireAuth,
	(c: any) => fidSettings.setPdsUrl(c, getAccountDO(c.env, c.get("did"))),
);

// Get handle configuration
app.get(
	"/xrpc/is.fid.settings.getHandle",
	requireAuth,
	(c: any) => fidSettings.getHandle(c, getAccountDO(c.env, c.get("did"))),
);

// Set handle
app.post(
	"/xrpc/is.fid.settings.setHandle",
	requireAuth,
	(c: any) => fidSettings.setHandle(c, getAccountDO(c.env, c.get("did"))),
);

// ============================================
// FID Passkey Endpoints
// ============================================

// Get passkey registration options
app.post(
	"/xrpc/is.fid.passkey.registrationOptions",
	requireAuth,
	(c: any) => fidPasskeys.registrationOptions(c, getAccountDO(c.env, c.get("did"))),
);

// Complete passkey registration
app.post(
	"/xrpc/is.fid.passkey.register",
	requireAuth,
	(c: any) => fidPasskeys.register(c, getAccountDO(c.env, c.get("did"))),
);

// List registered passkeys
app.get(
	"/xrpc/is.fid.passkey.list",
	requireAuth,
	(c: any) => fidPasskeys.list(c, getAccountDO(c.env, c.get("did"))),
);

// Rename a passkey
app.post(
	"/xrpc/is.fid.passkey.rename",
	requireAuth,
	(c: any) => fidPasskeys.rename(c, getAccountDO(c.env, c.get("did"))),
);

// Delete a passkey
app.post(
	"/xrpc/is.fid.passkey.delete",
	requireAuth,
	(c: any) => fidPasskeys.remove(c, getAccountDO(c.env, c.get("did"))),
);

// ============================================
// Handle Resolution
// ============================================

// Resolve handle - check if it matches our subdomain pattern
app.use("/xrpc/com.atproto.identity.resolveHandle", async (c, next) => {
	const handle = c.req.query("handle");
	if (!handle) {
		await next();
		return;
	}

	// Check if handle matches our subdomain pattern (NNN.{domain})
	// Users can change their handle to any DNS name, so we only resolve
	// handles that still match our subdomain format. Others get proxied.
	const domain = c.env.WEBFID_DOMAIN;
	const fid = hostnameToFid(handle, domain);
	if (fid !== null) {
		// Handle matches subdomain pattern - derive DID and check if account exists
		const did = fidToDid(fid, domain);
		const accountDO = getAccountDO(c.env, did);
		const identity = await accountDO.rpcGetAtprotoIdentity();
		if (identity) {
			return c.json({ did });
		}
	}

	// Handle doesn't match our pattern or account doesn't exist, proxy to AppView
	await next();
});

// ============================================
// Session Management (with Farcaster auth)
// ============================================

app.post("/xrpc/com.atproto.server.createSession", server.createSession);
app.post("/xrpc/com.atproto.server.refreshSession", (c) =>
	server.refreshSession(c, getAccountDO),
);
app.get("/xrpc/com.atproto.server.getSession", (c) =>
	server.getSession(c, getAccountDO),
);
app.post("/xrpc/com.atproto.server.deleteSession", server.deleteSession);

// ============================================
// Sync Endpoints (require FID context from auth)
// ============================================

// These endpoints use DID directly from the query parameter
app.get("/xrpc/com.atproto.sync.getRepo", async (c) => {
	const did = c.req.query("did");
	if (!did) {
		return c.json({ error: "InvalidRequest", message: "Missing did parameter" }, 400);
	}

	// Validate it's a routeable DID (WebFID)
	const domain = c.env.WEBFID_DOMAIN;
	if (!isWebFidDid(did, domain)) {
		return c.json({ error: "InvalidRequest", message: `Not a ${domain} DID` }, 400);
	}

	return sync.getRepo(c as any, getAccountDO(c.env, did));
});

app.get("/xrpc/com.atproto.sync.getLatestCommit", async (c) => {
	const did = c.req.query("did");
	if (!did) {
		return c.json({ error: "InvalidRequest", message: "Missing did parameter" }, 400);
	}

	const domain = c.env.WEBFID_DOMAIN;
	if (!isWebFidDid(did, domain)) {
		return c.json({ error: "InvalidRequest", message: `Not a ${domain} DID` }, 400);
	}

	return sync.getLatestCommit(c as any, getAccountDO(c.env, did));
});

app.get("/xrpc/com.atproto.sync.getRepoStatus", async (c) => {
	const did = c.req.query("did");
	if (!did) {
		return c.json({ error: "InvalidRequest", message: "Missing did parameter" }, 400);
	}

	const domain = c.env.WEBFID_DOMAIN;
	if (!isWebFidDid(did, domain)) {
		return c.json({ error: "InvalidRequest", message: `Not a ${domain} DID` }, 400);
	}

	return sync.getRepoStatus(c as any, getAccountDO(c.env, did));
});

app.get("/xrpc/com.atproto.sync.getRecord", async (c) => {
	const did = c.req.query("did");
	if (!did) {
		return c.json({ error: "InvalidRequest", message: "Missing did parameter" }, 400);
	}

	const domain = c.env.WEBFID_DOMAIN;
	if (!isWebFidDid(did, domain)) {
		return c.json({ error: "InvalidRequest", message: `Not a ${domain} DID` }, 400);
	}

	return sync.getRecord(c as any, getAccountDO(c.env, did));
});

app.get("/xrpc/com.atproto.sync.getBlob", async (c) => {
	const did = c.req.query("did");
	if (!did) {
		return c.json({ error: "InvalidRequest", message: "Missing did parameter" }, 400);
	}

	const domain = c.env.WEBFID_DOMAIN;
	if (!isWebFidDid(did, domain)) {
		return c.json({ error: "InvalidRequest", message: `Not a ${domain} DID` }, 400);
	}

	return sync.getBlob(c as any, getAccountDO(c.env, did));
});

// subscribeRepos WebSocket upgrades are handled before Hono in the default
// export below. Non-WebSocket requests to this endpoint get a helpful error.
app.get("/xrpc/com.atproto.sync.subscribeRepos", (c) => {
	return c.json(
		{
			error: "InvalidRequest",
			message: "This endpoint requires a WebSocket upgrade",
		},
		400,
	);
});

app.get("/xrpc/com.atproto.sync.listRepos", async (c) => {
	// Each subdomain hosts exactly one account
	const hostname = new URL(c.req.url).hostname;
	const domain = c.env.WEBFID_DOMAIN;
	const fid = hostnameToFid(hostname, domain);
	if (!fid) {
		return c.json({ repos: [] });
	}
	const did = fidToDid(fid, domain);
	const accountDO = getAccountDO(c.env, did);
	try {
		const data = await accountDO.rpcGetRepoStatus();

		// Deleted accounts return empty repos list
		if (data.status === "deleted") {
			return c.json({ repos: [], active: false, status: "deleted" });
		}

		const repo: Record<string, unknown> = {
			did: data.did,
			head: data.head,
			active: data.active,
		};
		if (data.active) {
			repo.rev = data.rev;
		} else {
			repo.status = data.status;
		}

		return c.json({ repos: [repo] });
	} catch {
		// Account may not exist yet
		return c.json({ repos: [] });
	}
});

// ============================================
// Repository Operations (require auth)
// ============================================

// Read operations - use DID directly from repo param
app.use("/xrpc/com.atproto.repo.describeRepo", async (c, next) => {
	const did = c.req.query("repo");
	const domain = c.env.WEBFID_DOMAIN;
	if (!did || !isWebFidDid(did, domain)) {
		await next();
		return;
	}
	return repo.describeRepo(c as any, getAccountDO(c.env, did));
});

app.use("/xrpc/com.atproto.repo.getRecord", async (c, next) => {
	const did = c.req.query("repo");
	const domain = c.env.WEBFID_DOMAIN;
	if (!did || !isWebFidDid(did, domain)) {
		await next();
		return;
	}
	return repo.getRecord(c as any, getAccountDO(c.env, did));
});

app.use("/xrpc/com.atproto.repo.listRecords", async (c, next) => {
	const did = c.req.query("repo");
	const domain = c.env.WEBFID_DOMAIN;
	if (!did || !isWebFidDid(did, domain)) {
		await next();
		return;
	}
	return repo.listRecords(c as any, getAccountDO(c.env, did));
});

// Write operations - require auth and use authenticated DID
app.post(
	"/xrpc/com.atproto.repo.createRecord",
	requireAuth,
	(c: any) => repo.createRecord(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.repo.deleteRecord",
	requireAuth,
	(c: any) => repo.deleteRecord(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.repo.uploadBlob",
	requireAuth,
	(c: any) => repo.uploadBlob(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.repo.applyWrites",
	requireAuth,
	(c: any) => repo.applyWrites(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.repo.putRecord",
	requireAuth,
	(c: any) => repo.putRecord(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.repo.importRepo",
	requireAuth,
	(c: any) => repo.importRepo(c, getAccountDO(c.env, c.get("did"))),
);
app.get(
	"/xrpc/com.atproto.repo.listMissingBlobs",
	requireAuth,
	(c: any) => repo.listMissingBlobs(c, getAccountDO(c.env, c.get("did"))),
);

// ============================================
// Account Lifecycle
// ============================================

app.get(
	"/xrpc/com.atproto.server.checkAccountStatus",
	requireAuth,
	(c: any) => server.checkAccountStatus(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.server.activateAccount",
	requireAuth,
	(c: any) => server.activateAccount(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/com.atproto.server.deactivateAccount",
	requireAuth,
	(c: any) => server.deactivateAccount(c, getAccountDO(c.env, c.get("did"))),
);
app.post("/xrpc/gg.mk.experimental.resetMigration", requireAuth, (c: any) =>
	server.resetMigration(c, getAccountDO(c.env, c.get("did"))),
);
app.post(
	"/xrpc/gg.mk.experimental.emitIdentityEvent",
	requireAuth,
	async (c: any) => {
		const did = c.get("did") as string;
		const accountDO = getAccountDO(c.env, did);
		const identity = await accountDO.rpcGetAtprotoIdentity();
		if (!identity) {
			return c.json(
				{ error: "AccountNotFound", message: "Account not found" },
				404,
			);
		}
		const result = await accountDO.rpcEmitIdentityEvent(identity.handle);
		return c.json(result);
	},
);
app.post(
	"/xrpc/gg.mk.experimental.emitAccountEvent",
	requireAuth,
	async (c: any) => {
		const did = c.get("did") as string;
		const accountDO = getAccountDO(c.env, did);
		const repoStatus = await accountDO.rpcGetRepoStatus();
		const active = repoStatus.active;
		const status = active ? undefined : repoStatus.status;
		// Emit #account event reflecting current repo status
		await accountDO.rpcEmitAccountEvent(active, status);
		return c.json({ success: true, active, status: status ?? "active" });
	},
);
app.get(
	"/xrpc/gg.mk.experimental.getFirehoseStatus",
	requireAuth,
	async (c: any) => {
		const did = c.get("did") as string;
		const accountDO = getAccountDO(c.env, did);
		const result = await accountDO.rpcGetFirehoseStatus();
		return c.json(result);
	},
);
app.post(
	"/xrpc/gg.mk.experimental.setRepoStatus",
	requireAuth,
	async (c: any) => {
		const did = c.get("did") as string;
		const body = (await c.req.json().catch(() => null)) as { status: string } | null;
		if (!body?.status || !["active", "deactivated", "deleted"].includes(body.status)) {
			return c.json(
				{ error: "InvalidRequest", message: "status must be active, deactivated, or deleted" },
				400,
			);
		}
		const accountDO = getAccountDO(c.env, did);
		await accountDO.rpcSetRepoStatus(body.status);
		return c.json({ success: true, status: body.status });
	},
);
app.post(
	"/xrpc/com.atproto.server.requestEmailUpdate",
	requireAuth,
	server.requestEmailUpdate,
);
app.post(
	"/xrpc/com.atproto.server.requestEmailConfirmation",
	requireAuth,
	server.requestEmailConfirmation,
);
app.post("/xrpc/com.atproto.server.updateEmail", requireAuth, (c: any) =>
	server.updateEmail(c, getAccountDO(c.env, c.get("did"))),
);

// ============================================
// Preferences
// ============================================

app.get("/xrpc/app.bsky.actor.getPreferences", requireAuth, async (c: any) => {
	const accountDO = getAccountDO(c.env, c.get("did"));
	const result = accountDO.rpcGetPreferences();
	return c.json(await result);
});

app.post("/xrpc/app.bsky.actor.putPreferences", requireAuth, async (c: any) => {
	const body = (await c.req.json()) as { preferences: unknown[] };
	const accountDO = getAccountDO(c.env, c.get("did"));
	await accountDO.rpcPutPreferences(body.preferences);
	return c.json({});
});

// ============================================
// Service Auth
// ============================================

app.get("/xrpc/com.atproto.server.getServiceAuth", requireAuth, (c: any) =>
	server.getServiceAuth(c, getAccountDO(c.env, c.get("did"))),
);

// ============================================
// Proxy Unhandled XRPC to AppView
// ============================================

app.all("/xrpc/*", async (c) => {
	return handleXrpcProxy(c as any, didResolver, async (userDid: string) => {
		const accountDO = getAccountDO(c.env, userDid);
		const identity = await accountDO.rpcGetAtprotoIdentity();
		if (!identity?.signingKey) {
			throw new Error("No signing key found for user");
		}
		return getSigningKeypair(identity.signingKey);
	}, getAccountDO, c.get("did"));
});

// Export a custom worker that intercepts WebSocket upgrades before Hono.
// Hono wraps Response objects in its middleware pipeline, which strips the
// non-standard `webSocket` property from 101 responses. This causes Cloudflare
// Workers to return a 500 instead of completing the WebSocket handshake.
export default {
	async fetch(
		request: Request,
		workerEnv: PDSEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Handle WebSocket upgrades directly, bypassing Hono
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			const url = new URL(request.url);
			if (
				url.pathname === "/xrpc/com.atproto.sync.subscribeRepos"
			) {
				const domain = workerEnv.WEBFID_DOMAIN;
				const fid = hostnameToFid(url.hostname, domain);
				if (!fid) {
					return new Response(
						JSON.stringify({
							error: "InvalidRequest",
							message: "Invalid hostname",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const did = fidToDid(fid, domain);
				const accountDO = getAccountDO(workerEnv, did);

				// Always forward to the DO — it handles tombstone responses
				// for deleted accounts (sends #account event then closes)
				return accountDO.fetch(request);
			}
		}

		// Everything else goes through Hono
		return app.fetch(request, workerEnv, ctx);
	},
};
