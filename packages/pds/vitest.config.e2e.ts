import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.ts"],
		globals: true,
		globalSetup: ["./e2e/setup.ts"],
		testTimeout: 30000,
		hookTimeout: 60000,
		maxWorkers: 1,
		isolate: false,
	},
});
