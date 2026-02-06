import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		globals: true,
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: [
						"multiformats",
						"multiformats/hashes/digest",
						"multiformats/hashes/sha2",
						"multiformats/cid",
						"@atproto/repo",
						"@atproto/lex-cbor",
						"@atproto/lex-data",
						"@atproto/crypto",
						"@atproto/common",
						"@atproto/common-web",
						"tslib",
						"bcryptjs",
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
						// Start accounts active by default in tests
						INITIAL_ACTIVE: "true",
					},
				},
				singleWorker: true,
			},
		},
		exclude: ["test/cli/**", "node_modules/**"],
	},
});
