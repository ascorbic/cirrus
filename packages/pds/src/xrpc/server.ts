import type { Context } from "hono";

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
