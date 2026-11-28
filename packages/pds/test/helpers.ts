/**
 * Test helpers with properly typed env
 */
import { env as _env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
export { runInDurableObject } from "cloudflare:test";
import app from "../src/index";
import type { PDSEnv } from "../src/types";

// Re-export env with correct type for tests
export const env = _env as PDSEnv;

/**
 * The worker under test, called directly with a fresh ExecutionContext per
 * request. Not through the `exports.default` loopback: every loopback call
 * left the next one slower (1000 requests took a trivial 404 from ~1ms to
 * ~190ms), which made the suite quadratic and timed out the conformance
 * run in CI. waitUntil work is left running, as in production.
 */
export const worker = {
	fetch(request: Request, env: PDSEnv): Promise<Response> {
		return Promise.resolve(app.fetch(request, env, createExecutionContext()));
	},
};
