import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// @atproto/space (and @atproto/jwk-jose) depend on jose@5, whose Node build
// cannot sign or verify under workerd's nodejs_compat in the vitest pool;
// production builds pick jose's `workerd` condition (the WebCrypto build).
// Redirect only THOSE importers to the browser build — the PDS's own
// session code uses jose@6 and must keep resolving normally.
const spaceRequire = createRequire(
	createRequire(import.meta.url).resolve("@atproto/space"),
);
const jose5Browser = join(
	dirname(spaceRequire.resolve("jose/package.json")),
	"dist/browser/index.js",
);

export default defineConfig({
	plugins: [
		{
			name: "jose5-workerd-build",
			enforce: "pre",
			resolveId(source, importer) {
				if (
					source === "jose" &&
					importer &&
					/@atproto[+/](space|jwk)/.test(importer)
				) {
					return jose5Browser;
				}
				return null;
			},
		},
		cloudflareTest({
			wrangler: { configPath: "./test/fixtures/pds-worker/wrangler.jsonc" },
			miniflare: {
				bindings: {
					DID: "did:web:pds.test",
					HANDLE: "alice.test",
					PDS_HOSTNAME: "pds.test",
					AUTH_TOKEN: "test-token",
					SIGNING_KEY:
						"e5b452e70de7fb7864fdd7f0d67c6dbd0f128413a1daa1b2b8a871e906fc90cc",
					SIGNING_KEY_PUBLIC:
						"zQ3shbUq6umkAhwsxEXj6fRZ3ptBtF5CNZbAGoKjvFRatUkVY",
					JWT_SECRET: "test-jwt-secret-at-least-32-chars-long",
					PASSWORD_HASH:
						"$2b$10$B6MKXNJ33Co3RoIVYAAvvO3jImuMiqL1T1YnFDN7E.hTZLtbB4SW6",
					// Start accounts active by default in tests
					INITIAL_ACTIVE: "true",
					// Exercise the spaces alpha in tests
					SPACES_ENABLED: "true",
				},
			},
		}),
	],
	resolve: {
		conditions: ["worker", "browser", "node", "require"],
		alias: {
			pino: "pino/browser.js",
		},
	},
	test: {
		globals: true,
		// Several proxy tests hit the live AppView; its latency regularly
		// pushes past vitest's 5s default and flakes CI.
		testTimeout: 15000,
		// Vitest 4: singleWorker is now maxWorkers: 1, isolate: false
		maxWorkers: 1,
		isolate: false,
		exclude: ["test/cli/**", "node_modules/**"],
	},
});
