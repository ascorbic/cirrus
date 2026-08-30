import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const require = createRequire(import.meta.url);
// The vitest pool resolves `jose` to its Node build, whose KeyObject-based
// signing fails under workerd's nodejs_compat. Production builds (wrangler)
// pick the `workerd` condition; force the same WebCrypto build here.
const joseBrowser = join(
	dirname(require.resolve("jose/package.json")),
	"dist/browser/index.js",
);

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
			jose: joseBrowser,
		},
	},
	test: {
		globals: true,
		maxWorkers: 1,
		isolate: false,
		exclude: ["node_modules/**"],
	},
});
