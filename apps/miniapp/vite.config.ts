import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		strictPort: true, // Fail if port is in use
		allowedHosts: true, // Allow any host (for tunneling)
	},
	build: {
		outDir: "dist",
	},
	define: {
		// Polyfill for libraries that check for Buffer
		global: "globalThis",
	},
	resolve: {
		alias: {
			// Polyfill buffer for browser
			buffer: "buffer",
		},
	},
	optimizeDeps: {
		esbuildOptions: {
			// Define global for libraries expecting Node environment
			define: {
				global: "globalThis",
			},
		},
	},
});
