import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
	plugins: [
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
		// Vitest 4: singleWorker is now maxWorkers: 1, isolate: false
		maxWorkers: 1,
		isolate: false,
	},
});
