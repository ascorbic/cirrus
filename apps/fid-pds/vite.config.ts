import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	plugins: [
		cloudflare({
			configPath: "./wrangler.jsonc",
		}),
	],
	server: {
		port: 8787,
		strictPort: true, // Fail if port is in use
		allowedHosts: true, // Allow tunnel hosts
		cors: false, // Worker's Hono CORS handles preflight (matches production)
	},
	resolve: {
		alias: {
			// Required for dev mode - pino (used by @atproto) doesn't work in Workers
			pino: "pino/browser.js",
		},
	},
});
