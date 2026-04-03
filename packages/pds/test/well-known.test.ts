import { describe, expect, it } from "vitest";
import { worker } from "./helpers";

describe("well-known endpoints", () => {
	it("serves atproto-did even when handle differs from PDS hostname", async () => {
		const response = await worker.fetch(
			new Request("http://pds.test/.well-known/atproto-did"),
			{
				DID: "did:web:domain.com",
				HANDLE: "domain.com",
				PDS_HOSTNAME: "pds.domain.com",
				AUTH_TOKEN: "test-token",
				SIGNING_KEY:
					"e5b452e70de7fb7864fdd7f0d67c6dbd0f128413a1daa1b2b8a871e906fc90cc",
				SIGNING_KEY_PUBLIC:
					"zQ3shbUq6umkAhwsxEXj6fRZ3ptBtF5CNZbAGoKjvFRatUkVY",
				JWT_SECRET: "test-jwt-secret-at-least-32-chars-long",
				PASSWORD_HASH:
					"$2b$10$B6MKXNJ33Co3RoIVYAAvvO3jImuMiqL1T1YnFDN7E.hTZLtbB4SW6",
				INITIAL_ACTIVE: "true",
			},
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("did:web:domain.com");
		expect(response.headers.get("Content-Type")).toContain("text/plain");
	});
});
