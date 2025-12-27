import type { Context } from "hono";
import { AccountDurableObject } from "../account-do";

export async function describeRepo(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");

	if (!repo) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: repo",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const data = await accountDO.rpcDescribeRepo();

	return c.json({
		did: c.env.DID,
		handle: c.env.HANDLE,
		didDoc: {
			"@context": ["https://www.w3.org/ns/did/v1"],
			id: c.env.DID,
			alsoKnownAs: [`at://${c.env.HANDLE}`],
			verificationMethod: [
				{
					id: `${c.env.DID}#atproto`,
					type: "Multikey",
					controller: c.env.DID,
					publicKeyMultibase: c.env.SIGNING_KEY_PUBLIC,
				},
			],
		},
		collections: data.collections,
		handleIsCorrect: true,
	});
}

export async function getRecord(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");
	const collection = c.req.query("collection");
	const rkey = c.req.query("rkey");

	if (!repo || !collection || !rkey) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, rkey",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const result = await accountDO.rpcGetRecord(collection, rkey);

	if (!result) {
		return c.json(
			{
				error: "RecordNotFound",
				message: `Record not found: ${collection}/${rkey}`,
			},
			404,
		);
	}

	return c.json({
		uri: `at://${repo}/${collection}/${rkey}`,
		cid: result.cid,
		value: result.record,
	});
}

export async function listRecords(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const repo = c.req.query("repo");
	const collection = c.req.query("collection");
	const limitStr = c.req.query("limit");
	const cursor = c.req.query("cursor");
	const reverseStr = c.req.query("reverse");

	if (!repo || !collection) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "RepoNotFound",
				message: `Repository not found: ${repo}`,
			},
			404,
		);
	}

	const limit = Math.min(limitStr ? Number.parseInt(limitStr, 10) : 50, 100);
	const reverse = reverseStr === "true";

	const result = await accountDO.rpcListRecords(collection, {
		limit,
		cursor,
		reverse,
	});

	return c.json(result);
}

export async function createRecord(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, collection, rkey, record } = body;

	if (!repo || !collection || !record) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, record",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	const result = await accountDO.rpcCreateRecord(collection, rkey, record);

	return c.json(result);
}

export async function deleteRecord(
	c: Context<{ Bindings: Env }>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req.json();
	const { repo, collection, rkey } = body;

	if (!repo || !collection || !rkey) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameters: repo, collection, rkey",
			},
			400,
		);
	}

	if (repo !== c.env.DID) {
		return c.json(
			{
				error: "InvalidRepo",
				message: `Invalid repository: ${repo}`,
			},
			400,
		);
	}

	const result = await accountDO.rpcDeleteRecord(collection, rkey);

	if (!result) {
		return c.json(
			{
				error: "RecordNotFound",
				message: `Record not found: ${collection}/${rkey}`,
			},
			404,
		);
	}

	return c.json(result);
}
