// Core exports for advanced users
export { SqliteRepoStorage } from "./storage";
export { AccountDurableObject } from "./account-do";
export { BlobStore, type BlobRef } from "./blobs";
export { Sequencer } from "./sequencer";
export { createServiceJwt } from "./service-auth";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "cloudflare:workers";
import { Secp256k1Keypair } from "@atproto/crypto";
import { ensureValidDid, ensureValidHandle } from "@atproto/syntax";
import { requireAuth } from "./middleware/auth";
import { createServiceJwt } from "./service-auth";
import { verifyAccessToken } from "./session";
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

// Bluesky service DIDs for service auth
const APPVIEW_DID = "did:web:api.bsky.app";
const CHAT_DID = "did:web:api.bsky.chat";

// Lazy-loaded keypair for service auth
let keypairPromise: Promise<Secp256k1Keypair> | null = null;
function getKeypair(): Promise<Secp256k1Keypair> {
	if (!keypairPromise) {
		keypairPromise = Secp256k1Keypair.import(env.SIGNING_KEY);
	}
	return keypairPromise;
}

const app = new Hono<{ Bindings: Env }>();

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
app.get("/.well-known/atproto-did", (c) => {
	return new Response(c.env.DID, {
		headers: { "Content-Type": "text/plain" },
	});
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
app.post("/xrpc/com.atproto.repo.putRecord", requireAuth, (c) =>
	repo.putRecord(c, getAccountDO(c.env)),
);
app.post("/xrpc/com.atproto.repo.importRepo", requireAuth, (c) =>
	repo.importRepo(c, getAccountDO(c.env)),
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

// Account migration
app.get("/xrpc/com.atproto.server.checkAccountStatus", requireAuth, (c) =>
	server.checkAccountStatus(c, getAccountDO(c.env)),
);

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

// Admin: Emit identity event to refresh handle verification
app.post("/admin/emit-identity", requireAuth, async (c) => {
	const accountDO = getAccountDO(c.env);
	const result = await accountDO.rpcEmitIdentityEvent(c.env.HANDLE);
	return c.json(result);
});

// Proxy unhandled XRPC requests to Bluesky services
app.all("/xrpc/*", async (c) => {
	const url = new URL(c.req.url);
	url.protocol = "https:";

	// Extract XRPC method name from path (e.g., "app.bsky.feed.getTimeline")
	const lxm = url.pathname.replace("/xrpc/", "");

	// Route to appropriate service based on lexicon namespace
	const isChat = lxm.startsWith("chat.bsky.");
	url.host = isChat ? "api.bsky.chat" : "api.bsky.app";
	const audienceDid = isChat ? CHAT_DID : APPVIEW_DID;

	// Check for authorization header
	const auth = c.req.header("Authorization");
	let headers: Record<string, string> = {};

	if (auth?.startsWith("Bearer ")) {
		const token = auth.slice(7);
		const serviceDid = `did:web:${c.env.PDS_HOSTNAME}`;

		// Try to verify the token - if valid, create a service JWT
		try {
			// Check static token first
			let userDid: string;
			if (token === c.env.AUTH_TOKEN) {
				userDid = c.env.DID;
			} else {
				// Verify JWT
				const payload = await verifyAccessToken(
					token,
					c.env.JWT_SECRET,
					serviceDid,
				);
				userDid = payload.sub;
			}

			// Create service JWT for target service
			const keypair = await getKeypair();
			const serviceJwt = await createServiceJwt({
				iss: userDid,
				aud: audienceDid,
				lxm,
				keypair,
			});
			headers["Authorization"] = `Bearer ${serviceJwt}`;
		} catch {
			// Token verification failed - forward without auth
			// Target service will return appropriate error
		}
	}

	// Forward request with potentially replaced auth header
	// Remove original authorization header to prevent conflicts
	const originalHeaders = Object.fromEntries(c.req.raw.headers);
	delete originalHeaders["authorization"];

	const reqInit: RequestInit = {
		method: c.req.method,
		headers: {
			...originalHeaders,
			...headers,
		},
	};

	// Include body for non-GET requests
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		reqInit.body = c.req.raw.body;
	}

	return fetch(url.toString(), reqInit);
});

export default app;
