import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/cli/**/*.test.ts"],
		globals: true,
	},
});
