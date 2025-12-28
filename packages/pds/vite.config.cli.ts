import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/cli/index.ts"),
			formats: ["es"],
			fileName: () => "cli.js",
		},
		outDir: "dist",
		emptyOutDir: false,
		rollupOptions: {
			external: [
				/^node:/,
				/^@atproto\//,
				/^@clack\//,
				"citty",
				"bcryptjs",
			],
		},
		target: "node18",
	},
});
