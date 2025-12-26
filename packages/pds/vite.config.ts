import { defineConfig } from "vite"
import { cloudflare } from "@cloudflare/vite-plugin"

// Vite config for dev and build - testing uses vitest.config.ts
export default defineConfig({
	plugins: [cloudflare()],
})
