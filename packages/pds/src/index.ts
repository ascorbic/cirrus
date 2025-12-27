export { SqliteRepoStorage } from "./storage";
export { AccountDurableObject } from "./account-do";

import { Hono } from "hono";
import { requireAuth } from "./middleware/auth";
import * as sync from "./xrpc/sync";
import * as repo from "./xrpc/repo";
import * as server from "./xrpc/server";
import { version } from "../package.json" with { type: "json" };

const app = new Hono<{ Bindings: Env }>();

// Validate required environment variables
app.use("*", async (c, next) => {
	const required = [
		"DID",
		"HANDLE",
		"PDS_HOSTNAME",
		"AUTH_TOKEN",
		"SIGNING_KEY",
		"SIGNING_KEY_PUBLIC",
	] as const;
	for (const key of required) {
		if (!c.env[key]) {
			return c.json(
				{
					error: "ConfigurationError",
					message: `Missing required environment variable: ${key}`,
				},
				500,
			);
		}
	}
	await next();
});

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
	return c.json(didDocument, 200, {
		"Access-Control-Allow-Origin": "*",
	});
});

// Health check
app.get("/health", (c) =>
	c.json({
		status: "ok",
		version,
	}),
);

// Tier 1: Sync endpoints (federation)
app.get("/xrpc/com.atproto.sync.getRepo", (c) =>
	sync.getRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getRepoStatus", (c) =>
	sync.getRepoStatus(c, getAccountDO(c.env)),
);

// Tier 2: Repository operations
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

// Tier 3: Server identity
app.get("/xrpc/com.atproto.server.describeServer", server.describeServer);
app.get("/xrpc/com.atproto.identity.resolveHandle", server.resolveHandle);

export default app;
