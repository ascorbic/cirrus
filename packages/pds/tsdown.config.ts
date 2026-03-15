import { readFileSync } from "fs";
import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		format: ["esm"],
		fixedExtension: false,
		dts: true,
		external: [/^cloudflare:/],
		plugins: [
			{
				name: "html-loader",
				load(id) {
					if (id.endsWith(".html")) {
						const content = readFileSync(id, "utf-8");
						return `export default ${JSON.stringify(content)};`;
					}
				},
			},
		],
	},
	{
		entry: { cli: "src/cli/index.ts" },
		format: ["esm"],
		fixedExtension: false,
		outDir: "dist",
	},
]);
