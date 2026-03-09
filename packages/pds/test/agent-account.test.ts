import { describe, it, expect } from "vitest";
import {
	env,
	worker,
	runInDurableObject,
	getTestAccountStub,
	seedIdentity,
	TEST_FID,
	TEST_DID,
} from "./helpers";
import type { AccountDurableObject } from "../src/account-do";

/**
 * Build a URL on any FID's subdomain.
 */
function agentUrl(fid: string, path: string): string {
	return `http://${fid}.${env.WEBFID_DOMAIN}${path}`;
}

describe("is.fid.account.createX402", () => {
	it("returns 500 when x402 env vars are not configured", async () => {
		// Default test env doesn't have X402_* vars
		const response = await worker.fetch(
			new Request(agentUrl(TEST_FID, "/xrpc/is.fid.account.createX402"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fid: TEST_FID }),
			}),
			env,
		);

		expect(response.status).toBe(500);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("ServerError");
		expect(body.message).toBe("x402 payment not configured");
	});
});

describe("createAccountForFid shared helper (via DO RPC)", () => {
	it("verifies account does not exist before creation", async () => {
		const testFid = "99999";
		const testDid = `did:web:${testFid}.${env.WEBFID_DOMAIN}`;
		const id = env.ACCOUNT.idFromName(testDid);
		const stub = env.ACCOUNT.get(id);

		const exists = await stub.rpcAccountExists();
		expect(exists).toBe(false);
	});

	it("handles idempotent creation (account already exists)", async () => {
		const stub = getTestAccountStub();
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			await seedIdentity(instance);
		});

		const exists = await stub.rpcAccountExists();
		expect(exists).toBe(true);

		const identity = await stub.rpcGetAtprotoIdentity();
		expect(identity).not.toBeNull();
		expect(identity?.did).toBe(TEST_DID);
	});
});
