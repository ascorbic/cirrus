import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		format: ["esm"],
		outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
		dts: true,
		external: [/^cloudflare:/, "hono", "hono/cors", "jose", "bcryptjs"],
		alias: {
			pino: "pino/browser.js",
		},
	},
	{
		entry: { cli: "src/cli/index.ts" },
		format: ["esm"],
		outExtensions: () => ({ js: ".js" }),
		outDir: "dist",
		external: [
			/^node:/,
			/^@atproto\//,
			/^@clack\//,
			"citty",
			"bcryptjs",
			"wrangler",
		],
	},
]);
