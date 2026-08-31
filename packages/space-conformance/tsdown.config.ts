import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: {
			index: "src/index.ts",
			full: "src/full.ts",
			cli: "src/cli/main.ts",
		},
		format: ["esm"],
		fixedExtension: false,
		dts: true,
	},
]);
