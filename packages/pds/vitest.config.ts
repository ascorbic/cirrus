import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
	test: {
		globals: true,
		poolOptions: {
			workers: {
				singleWorker: true,
				isolatedStorage: false, // Disable isolated storage - DO tests manage their own isolation
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						DID: "did:web:pds.test",
						HANDLE: "alice.test",
						PDS_HOSTNAME: "pds.test",
						AUTH_TOKEN: "test-token",
						SIGNING_KEY: "test-signing-key",
						SIGNING_KEY_PUBLIC: "test-signing-key-public",
					},
				},
			},
		},
	},
})
