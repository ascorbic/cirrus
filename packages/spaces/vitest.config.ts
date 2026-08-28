import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./test/fixtures/spaces-worker/wrangler.jsonc" },
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
		maxWorkers: 1,
		isolate: false,
		exclude: ["node_modules/**"],
	},
});
