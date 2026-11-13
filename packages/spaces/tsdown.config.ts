import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		format: ["esm"],
		fixedExtension: false,
		dts: true,
		// A Workers library. The alpha @atproto packages are devDependencies,
		// so they are bundled (consumers must never resolve their broken
		// prerelease ranges); resolve their browser builds rather than the
		// Node ones, which reach for node:crypto and node:buffer.
		platform: "browser",
		external: [/^cloudflare:/],
	},
]);
