import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	configFile: false,
	plugins: [
		cloudflare({
			configPath: "./wrangler.dev.jsonc",
		}),
	],
	server: {
		port: 8787,
		allowedHosts: true, // Allow tunnel hosts
		cors: {
			origin: "*",
			methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowedHeaders: ["Content-Type", "Authorization", "atproto-accept-labelers"],
		},
	},
	resolve: {
		alias: {
			// Required for dev mode - pino (used by @atproto) doesn't work in Workers
			pino: "pino/browser.js",
		},
	},
});
