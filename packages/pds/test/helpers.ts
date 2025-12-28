/**
 * Test helpers with properly typed env
 */
import { env as _env, exports } from "cloudflare:workers";
export { runInDurableObject } from "cloudflare:test";
import type { PDSEnv } from "../src/types";

// Re-export env with correct type for tests
export const env = _env as PDSEnv;

// Worker fetch using exports.default
export const worker = (
	exports as {
		default: { fetch: (request: Request, env: PDSEnv) => Promise<Response> };
	}
).default;
