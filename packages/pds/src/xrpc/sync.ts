import type { Context } from "hono";
import type { AccountDurableObject } from "../account-do.js";

export async function getRepo(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.req.query("did");

	if (!did) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: did",
			},
			400,
		);
	}

	if (did !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found for DID: ${did}`,
			},
			404,
		);
	}

	const carBytes = await accountDO.rpcGetRepoCar();

	return new Response(carBytes, {
		status: 200,
		headers: {
			"Content-Type": "application/vnd.ipld.car",
			"Content-Length": carBytes.length.toString(),
		},
	});
}

export async function getRepoStatus(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.req.query("did");

	if (!did) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: did",
			},
			400,
		);
	}

	if (did !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found for DID: ${did}`,
			},
			404,
		);
	}

	const data = await accountDO.rpcGetRepoStatus();

	return c.json({
		did: data.did,
		active: true,
		status: "active",
		rev: data.rev,
	});
}
