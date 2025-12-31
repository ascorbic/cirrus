import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			// Help vitest find packages in node_modules
			"@atproto/api": resolve(__dirname, "node_modules/@atproto/api"),
			"@atproto/syntax": resolve(__dirname, "node_modules/@atproto/syntax"),
			"@ipld/car": resolve(__dirname, "node_modules/@ipld/car"),
			ws: resolve(__dirname, "node_modules/ws"),
		},
	},
	test: {
		include: ["e2e/**/*.e2e.ts"],
		globals: true,
		globalSetup: ["./e2e/setup.ts"],
		testTimeout: 30000,
		hookTimeout: 60000,
		maxWorkers: 1,
		isolate: false,
	},
});
