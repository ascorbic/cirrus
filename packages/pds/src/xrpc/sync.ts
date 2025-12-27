import type { Context } from "hono";
import { ensureValidDid } from "@atproto/syntax";
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

	// Validate DID format
	try {
		ensureValidDid(did);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
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

	// Validate DID format
	try {
		ensureValidDid(did);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
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

export async function getBlob(
	c: Context<{ Bindings: Env }>,
	_accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.req.query("did");
	const cid = c.req.query("cid");

	if (!did || !cid) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: did, cid",
			},
			400,
		);
	}

	// Validate DID format
	try {
		ensureValidDid(did);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid DID format: ${err instanceof Error ? err.message : String(err)}`,
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

	// Check if blob storage is configured
	if (!c.env.BLOBS) {
		return c.json(
			{
				error: "ServiceUnavailable",
				message: "Blob storage is not configured",
			},
			503,
		);
	}

	// Access R2 directly (R2ObjectBody can't be serialized across RPC)
	const key = `${did}/${cid}`;
	const blob = await c.env.BLOBS.get(key);

	if (!blob) {
		return c.json(
			{
				error: "BlobNotFound",
				message: `Blob not found: ${cid}`,
			},
			404,
		);
	}

	return new Response(blob.body, {
		status: 200,
		headers: {
			"Content-Type":
				blob.httpMetadata?.contentType || "application/octet-stream",
			"Content-Length": blob.size.toString(),
		},
	});
}
