import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The reference PDS harness (@atproto/dev-env) runs a real Node HTTP
		// server backed by better-sqlite3, so this suite runs in Node, not the
		// workers pool the other Cirrus packages use.
		environment: "node",
		// Booting the reference PLC + PDS and running the full catalog is well
		// under a minute, but give it headroom for a cold CI runner.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
