import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";

// Resolve @getcirrus/space-conformance to its TypeScript source rather than
// its built dist. Vite compiles the source directly, so the app build no
// longer depends on the package having been built first — the Workers
// Build (which runs `vite build` without building workspace deps) would
// otherwise fail to resolve the import. Only the dependency-free package
// root is used here, so the alpha crypto libs stay out of the bundle.
const conformanceSrc = fileURLToPath(
	new URL("../../packages/space-conformance/src/index.ts", import.meta.url),
);

export default defineConfig({
	plugins: [solid(), tailwind()],
	resolve: {
		alias: {
			"@getcirrus/space-conformance": conformanceSrc,
		},
	},
	server: {
		host: "127.0.0.1",
	},
});
