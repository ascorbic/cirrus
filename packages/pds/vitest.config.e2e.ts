import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

export default defineConfig({
	resolve: {
		alias: {
			// Help vitest find packages in node_modules (pnpm hoists to root)
			"@atproto/api": resolve(rootDir, "node_modules/@atproto/api"),
			"@ipld/car": resolve(rootDir, "node_modules/@ipld/car"),
			ws: resolve(rootDir, "node_modules/ws"),
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
