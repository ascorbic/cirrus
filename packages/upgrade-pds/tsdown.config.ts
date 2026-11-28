import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "src/index.ts",
	format: ["esm"],
	fixedExtension: false,
	alias: {
		// The package's `main` is a UMD build whose internal requires cannot be bundled.
		"jsonc-parser": "jsonc-parser/lib/esm/main.js",
	},
});
