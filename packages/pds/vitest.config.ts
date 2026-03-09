import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	resolve: {
		alias: {
			pino: "pino/browser.js",
		},
	},
	test: {
		globals: true,
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: [
						"multiformats",
						"@atproto/repo",
						"@atproto/lex-cbor",
						"@atproto/lex-data",
						"@atproto/lex-json",
						"@atproto/crypto",
						"@atproto/common",
						"@atproto/common-web",
						"@ipld/dag-cbor",
						"uint8arrays",
					],
				},
			},
		},
		poolOptions: {
			workers: {
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
						INITIAL_ACTIVE: "true",
						WEBFID_DOMAIN: "fid.test",
						QUICKAUTH_DOMAIN: "my.fid.test",
						ALCHEMY_API_KEY: "test-key",
					},
				},
				singleWorker: true,
			},
		},
		exclude: ["test/cli/**", "node_modules/**"],
	},
});
