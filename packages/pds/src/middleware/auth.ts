import type { Context, Next } from "hono";

export async function requireAuth(
	c: Context<{ Bindings: Env }>,
	next: Next,
): Promise<Response | void> {
	const auth = c.req.header("Authorization");

	if (!auth?.startsWith("Bearer ")) {
		return c.json(
			{
				error: "AuthMissing",
				message: "Authorization header required",
			},
			401,
		);
	}

	const token = auth.slice(7);
	if (token !== c.env.AUTH_TOKEN) {
		return c.json(
			{
				error: "AuthenticationRequired",
				message: "Invalid authentication token",
			},
			401,
		);
	}

	return next();
}
