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

import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth } from "./middleware/auth";
import { DidResolver } from "./did-resolver";
import { WorkersDidCache } from "./did-cache";
import { handleXrpcProxy } from "./xrpc-proxy";
import { createOAuthApp } from "./oauth";
import * as sync from "./xrpc/sync";
import * as repo from "./xrpc/repo";
import * as server from "./xrpc/server";
import * as fidAccount from "./xrpc/fid-account";
import {
	hostnameToFid,
	fidToDid,
	fidToHandle,
} from "./farcaster-auth";
import type { PDSEnv, AppEnv } from "./types";
import type { AccountDurableObject } from "./account-do";

import { version } from "../package.json" with { type: "json" };

const didResolver = new DidResolver({
	didCache: new WorkersDidCache(),
	timeout: 3000,
	plcUrl: "https://plc.directory",
});

const app = new Hono<AppEnv>();

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

	// Return the deterministic DID
	const did = fidToDid(fid, domain);
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
	const handle = fidToHandle(fid, domain);

	// Fetch the public key from the account's DO (route by DID)
	const accountDO = getAccountDO(c.env, did);
	const publicKey = await accountDO.rpcGetAtprotoPublicKey();

	if (!publicKey) {
		return c.json(
			{ error: "AccountNotFound", message: "Account not found" },
			404,
		);
	}

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
				publicKeyMultibase: publicKey,
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				// Use per-user subdomain as PDS endpoint (matches DID structure)
				serviceEndpoint: `https://${handle}`,
			},
		],
	};
	return c.json(didDocument);
});

// ============================================
// XRPC Endpoints (served on NNN.fid.is per-user subdomains)
// ============================================

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
<title>fid.is PDS</title>
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
.logo { font-size: clamp(4rem, 15vw, 10rem); line-height: 1; }
.name { font-size: clamp(1.5rem, 5vw, 3rem); font-weight: 700; letter-spacing: 0.2em; margin: 1rem 0; }
.what { font-size: clamp(0.8rem, 2vw, 1rem); color: #666; max-width: 400px; text-align: center; }
.version { position: fixed; bottom: 1rem; right: 1rem; font-size: 0.7rem; color: #999; }
</style>
</head>
<body>
<div class="logo">🟣</div>
<div class="name">FID.IS</div>
<div class="what">Farcaster-to-ATProto Bridge<br/>Bring your FID to the Atmosphere</div>
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

// Login with Farcaster auth
app.post("/xrpc/is.fid.auth.login", (c) =>
	fidAccount.loginWithFarcaster(c, getAccountDO),
);

// Login with Sign In With Farcaster (browser-based)
app.post("/xrpc/is.fid.auth.siwf", (c) =>
	fidAccount.loginWithSiwf(c, getAccountDO),
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
		const hasCredentials = await accountDO.rpcHasAtprotoIdentity();
		if (hasCredentials) {
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

app.get("/xrpc/com.atproto.sync.listRepos", (c) => {
	// This would need to enumerate all accounts - not supported in multi-tenant mode
	return c.json({ repos: [], cursor: undefined });
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
	// For proxy, we need to create a service JWT
	// In multi-tenant mode, we'd need to get the keypair from the authenticated user's DO
	// For now, proxy without service auth for public endpoints
	const auth = c.req.header("Authorization");
	if (!auth) {
		// No auth, just proxy as-is
		return handleXrpcProxy(c as any, didResolver, async () => {
			throw new Error("No keypair available for unauthenticated requests");
		}, getAccountDO);
	}

	// TODO: For authenticated proxy requests, we'd need to:
	// 1. Verify the token and get the DID
	// 2. Load the keypair from that user's DO
	// 3. Create service JWT with their identity
	// For now, this is a limitation of the multi-tenant architecture
	return handleXrpcProxy(c as any, didResolver, async () => {
		throw new Error("Authenticated proxy not yet implemented");
	}, getAccountDO);
});

export default app;
