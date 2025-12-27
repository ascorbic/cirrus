import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";

describe("Environment Variable Validation", () => {
	describe("Main Worker", () => {
		// Note: AccountDurableObject also validates SIGNING_KEY and DID in its constructor,
		// but we can't easily test that in integration tests because the DO namespace
		// binding controls the env. The validation is straightforward (throws if missing).
		const requiredVars = [
			"DID",
			"HANDLE",
			"PDS_HOSTNAME",
			"AUTH_TOKEN",
			"SIGNING_KEY",
			"SIGNING_KEY_PUBLIC",
		] as const;

		for (const varName of requiredVars) {
			it(`should return 500 when ${varName} is missing`, async () => {
				// Create env with the variable removed
				const invalidEnv = { ...env };
				delete (invalidEnv as any)[varName];

				const response = await worker.fetch(
					new Request("http://pds.test/xrpc/com.atproto.server.describeServer"),
					invalidEnv as any,
				);

				expect(response.status).toBe(500);
				const data = await response.json();
				expect(data).toMatchObject({
					error: "ConfigurationError",
					message: `Missing required environment variable: ${varName}`,
				});
			});
		}
	});
});
