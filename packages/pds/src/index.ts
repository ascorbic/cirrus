export { SqliteRepoStorage } from "./storage";
export { AccountDurableObject } from "./account-do";

import { Hono } from "hono";
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

// Sync endpoints (federation)
app.get("/xrpc/com.atproto.sync.getRepo", (c) =>
	sync.getRepo(c, getAccountDO(c.env)),
);
app.get("/xrpc/com.atproto.sync.getRepoStatus", (c) =>
	sync.getRepoStatus(c, getAccountDO(c.env)),
);

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

// Server identity
app.get("/xrpc/com.atproto.server.describeServer", server.describeServer);
app.get("/xrpc/com.atproto.identity.resolveHandle", server.resolveHandle);

export default app;
