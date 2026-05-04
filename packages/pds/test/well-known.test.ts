import { describe, expect, it } from "vitest";
import { env, worker } from "./helpers";

describe("well-known endpoints", () => {
	it("serves atproto-did even when handle differs from PDS hostname", async () => {
		expect(env.HANDLE).not.toBe(env.PDS_HOSTNAME);

		const response = await worker.fetch(
			new Request(`http://${env.PDS_HOSTNAME}/.well-known/atproto-did`),
			env,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(env.DID);
		expect(response.headers.get("Content-Type")).toContain("text/plain");
	});
});
