import type { ViteDevServer } from "vite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let server: ViteDevServer;
let tempDir: string;

export async function setup() {
	// Create tmp dir
	tempDir = await mkdtemp(join(tmpdir(), "pds-e2e-"));
	console.log(`Creating e2e test fixture in: ${tempDir}`);

	// Create src directory
	await mkdir(join(tempDir, "src"), { recursive: true });

	// Write src/index.ts - re-export from the built package
	await writeFile(
		join(tempDir, "src/index.ts"),
		`export { default, AccountDurableObject } from "@ascorbic/pds";\n`,
	);

	// Write wrangler.jsonc
	await writeFile(
		join(tempDir, "wrangler.jsonc"),
		JSON.stringify(
			{
				name: "pds-e2e-test",
				main: "src/index.ts",
				compatibility_date: "2025-01-01",
				compatibility_flags: ["nodejs_compat"],
				durable_objects: {
					bindings: [
						{ name: "ACCOUNT", class_name: "AccountDurableObject" },
					],
				},
				migrations: [
					{ tag: "v1", new_sqlite_classes: ["AccountDurableObject"] },
				],
				r2_buckets: [{ binding: "BLOBS", bucket_name: "test-blobs" }],
			},
			null,
			"\t",
		),
	);

	// Write .dev.vars with test credentials
	await writeFile(
		join(tempDir, ".dev.vars"),
		`DID=did:web:localhost
HANDLE=localhost
PDS_HOSTNAME=localhost
AUTH_TOKEN=test-token
SIGNING_KEY=e5b452e70de7fb7864fdd7f0d67c6dbd0f128413a1daa1b2b8a871e906fc90cc
SIGNING_KEY_PUBLIC=zQ3shbUq6umkAhwsxEXj6fRZ3ptBtF5CNZbAGoKjvFRatUkVY
JWT_SECRET=test-jwt-secret-at-least-32-chars-long
PASSWORD_HASH=$2b$10$B6MKXNJ33Co3RoIVYAAvvO3jImuMiqL1T1YnFDN7E.hTZLtbB4SW6
INITIAL_ACTIVE=true
`,
	);

	// Import vite and cloudflare plugin
	const { createServer } = await import("vite");
	const { cloudflare } = await import("@cloudflare/vite-plugin");

	// Start Vite dev server with cloudflare plugin
	// We provide the config inline rather than using a config file
	server = await createServer({
		root: tempDir,
		configFile: false, // Don't look for vite.config.ts
		plugins: [cloudflare()],
		resolve: {
			alias: {
				// Required for dev mode - pino (used by @atproto) doesn't work in Workers
				pino: "pino/browser.js",
			},
		},
		server: {
			// Let Vite pick an available port
			port: 0,
		},
		logLevel: "warn",
	});
	await server.listen();

	const address = server.httpServer?.address();
	const port = typeof address === "object" ? address?.port : 5173;

	console.log(`E2E test server started on port ${port}`);

	(globalThis as Record<string, unknown>).__e2e_server__ = server;
	(globalThis as Record<string, unknown>).__e2e_port__ = port;
	(globalThis as Record<string, unknown>).__e2e_tempDir__ = tempDir;
}

export async function teardown() {
	if (server) {
		await server.close();
		console.log("E2E test server stopped");
	}

	// Clean up temp directory
	if (tempDir) {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
