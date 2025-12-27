import type { Context } from "hono";
import { ensureValidHandle } from "@atproto/syntax";

export async function describeServer(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	return c.json({
		did: c.env.DID,
		availableUserDomains: [],
		inviteCodeRequired: false,
	});
}

export async function resolveHandle(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const handle = c.req.query("handle");

	if (!handle) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Missing required parameter: handle",
			},
			400,
		);
	}

	// Validate handle format
	try {
		ensureValidHandle(handle);
	} catch (err) {
		return c.json(
			{
				error: "InvalidRequest",
				message: `Invalid handle format: ${err instanceof Error ? err.message : String(err)}`,
			},
			400,
		);
	}

	if (handle !== c.env.HANDLE) {
		return c.json(
			{
				error: "HandleNotFound",
				message: `Handle not found: ${handle}`,
			},
			404,
		);
	}

	return c.json({
		did: c.env.DID,
	});
}
