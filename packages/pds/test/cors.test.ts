import { describe, expect, it } from "vitest";
import { env, worker } from "./helpers";

describe("CORS preflight", () => {
	it("reflects the Authorization header back in Access-Control-Allow-Headers", async () => {
		const response = await worker.fetch(
			new Request(
				`http://pds.test/xrpc/com.atproto.server.getSession`,
				{
					method: "OPTIONS",
					headers: {
						Origin: "https://example.com",
						"Access-Control-Request-Method": "GET",
						"Access-Control-Request-Headers": "authorization",
					},
				},
			),
			env,
		);

		expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
			"authorization",
		);
	});
});
