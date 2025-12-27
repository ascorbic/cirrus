// Core exports for advanced users
export { SqliteRepoStorage } from "./storage";
export { AccountDurableObject } from "./account-do";
export { BlobStore, type BlobRef } from "./blobs";
export { Sequencer } from "./sequencer";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { proxy } from "hono/proxy";
import { env } from "cloudflare:workers";
import { ensureValidDid, ensureValidHandle } from "@atproto/syntax";
import { requireAuth } from "./middleware/auth";
import * as sync from "./xrpc/sync";
import * as repo from "./xrpc/repo";
import * as server from "./xrpc/server";
import { version } from "../package.json" with { type: "json" };

// Validate required environment variables at module load
const required = [
	"DID",
	"HANDLE",
	"PDS_HOSTNAME",
	"AUTH_TOKEN",
	"SIGNING_KEY",
	"SIGNING_KEY_PUBLIC",
	"JWT_SECRET",
] as const;

for (const key of required) {
	if (!env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

// Validate DID and handle formats
try {
	ensureValidDid(env.DID);
	ensureValidHandle(env.HANDLE);
} catch (err) {
	throw new Error(
		`Invalid DID or handle: ${err instanceof Error ? err.message : String(err)}`,
	);
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware for all routes
app.use("*", cors({
	origin: "*",
	allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "atproto-accept-labelers", "atproto-proxy"],
	exposeHeaders: ["Content-Type"],
	maxAge: 86400,
}));

// Helper to get Account DO stub
function getAccountDO(env: Env) {
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

// Health check
app.get("/health", (c) =>
	c.json({
		status: "ok",
		version,
	}),
);

// Sync endpoints (federation)
app.get("/xrpc/com.atproto.sync.getRepo", (c) =>
	sync.getRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getRepoStatus", (c) =>
	sync.getRepoStatus(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getBlob", (c) =>
	sync.getBlob(c, getAccountDO(c.env)),
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

// Repository operations
app.get("/xrpc/com.atproto.repo.describeRepo", (c) =>
	repo.describeRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.repo.getRecord", (c) =>
	repo.getRecord(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.repo.listRecords", (c) =>
	repo.listRecords(c, getAccountDO(c.env)),
);

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

// Server identity
app.get("/xrpc/com.atproto.server.describeServer", server.describeServer);
app.get("/xrpc/com.atproto.identity.resolveHandle", server.resolveHandle);

// Session management
app.post("/xrpc/com.atproto.server.createSession", server.createSession);
app.post("/xrpc/com.atproto.server.refreshSession", server.refreshSession);
app.get("/xrpc/com.atproto.server.getSession", server.getSession);
app.post("/xrpc/com.atproto.server.deleteSession", server.deleteSession);

// Actor preferences (stub - returns empty preferences)
app.get("/xrpc/app.bsky.actor.getPreferences", requireAuth, (c) => {
	return c.json({ preferences: [] });
});
app.post("/xrpc/app.bsky.actor.putPreferences", requireAuth, async (c) => {
	// TODO: persist preferences in DO
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

// Proxy unhandled XRPC requests to Bluesky AppView
app.all("/xrpc/*", (c) => {
	const url = new URL(c.req.url);
	url.host = "api.bsky.app";
	url.protocol = "https:";
	return proxy(url, c.req);
});

export default app;
