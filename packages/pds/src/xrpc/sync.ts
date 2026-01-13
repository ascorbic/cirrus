import type { Context } from "hono";
import { isDid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import type { AccountDurableObject } from "../account-do.js";
import type { AppEnv } from "../types";

export async function getRepo(
	c: Context<AppEnv>,
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
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
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
	c: Context<AppEnv>,
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
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
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

export async function listRepos(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	// Single-user PDS - just return our one repo
	const data = await accountDO.rpcGetRepoStatus();

	return c.json({
		repos: [
			{
				did: data.did,
				head: data.head,
				rev: data.rev,
				active: true,
			},
		],
	});
}

export async function listBlobs(
	c: Context<AppEnv>,
	_accountDO: DurableObjectStub<AccountDurableObject>,
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
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
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
		// No blobs configured, return empty list
		return c.json({ cids: [] });
	}

	// List blobs from R2 with prefix
	const prefix = `${did}/`;
	const cursor = c.req.query("cursor");
	const limit = Math.min(Number(c.req.query("limit")) || 500, 1000);

	const listed = await c.env.BLOBS.list({
		prefix,
		limit,
		cursor: cursor || undefined,
	});

	// Extract CIDs from keys (keys are "${did}/${cid}")
	const cids = listed.objects.map((obj) => obj.key.slice(prefix.length));

	const result: { cids: string[]; cursor?: string } = { cids };
	if (listed.truncated && listed.cursor) {
		result.cursor = listed.cursor;
	}

	return c.json(result);
}

export async function getBlocks(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.req.query("did");
	const cidsParam = c.req.queries("cids");

	if (!did) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: did",
			},
			400,
		);
	}

	if (!cidsParam || cidsParam.length === 0) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: cids",
			},
			400,
		);
	}

	// Validate DID format
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
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

	const carBytes = await accountDO.rpcGetBlocks(cidsParam);

	return new Response(carBytes, {
		status: 200,
		headers: {
			"Content-Type": "application/vnd.ipld.car",
			"Content-Length": carBytes.length.toString(),
		},
	});
}

export async function getBlob(
	c: Context<AppEnv>,
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
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
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

export async function getRecord(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.req.query("did");
	const collection = c.req.query("collection");
	const rkey = c.req.query("rkey");

	if (!did) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: did",
			},
			400,
		);
	}

	if (!collection) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: collection",
			},
			400,
		);
	}

	if (!rkey) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: rkey",
			},
			400,
		);
	}

	// Validate DID format
	if (!isDid(did)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid DID format" },
			400,
		);
	}

	// Validate collection is an NSID
	if (!isNsid(collection)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid collection format (must be NSID)" },
			400,
		);
	}

	// Validate rkey format
	if (!isRecordKey(rkey)) {
		return c.json(
			{ error: "InvalidRequest", message: "Invalid rkey format" },
			400,
		);
	}

	// Check if this is our DID
	if (did !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found for DID: ${did}`,
			},
			404,
		);
	}

	try {
		const carBytes = await accountDO.rpcGetRecordProof(collection, rkey);

		return new Response(carBytes, {
			status: 200,
			headers: {
				"Content-Type": "application/vnd.ipld.car",
				"Content-Length": carBytes.length.toString(),
			},
		});
	} catch (err) {
		// The proof CAR will still be returned even if the record doesn't exist
		// (to prove non-existence), so errors here indicate storage issues
		console.error("Error getting record proof:", err);
		return c.json(
			{
				error: "InternalServerError",
				message: "Failed to get record proof",
			},
			500,
		);
	}
}
