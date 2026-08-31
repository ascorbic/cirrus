/**
 * Small HTTP helpers shared by checks. Every check talks to the target
 * over `ctx.fetch`, so a target is anything with a `fetch` — an in-process
 * Hono app, a live origin, or a mock.
 */

import type { CheckContext } from "./model.js";

export function xrpcUrl(
	origin: string,
	nsid: string,
	params?: Record<string, string | undefined>,
): string {
	const url = new URL(`${origin}/xrpc/${nsid}`);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	return url.toString();
}

export interface XrpcResult {
	status: number;
	/** Parsed JSON body, or undefined for non-JSON responses. */
	json?: unknown;
	/** The atproto `error` name, when the body carries one. */
	error?: string;
	headers: Headers;
	response: Response;
}

async function toResult(response: Response): Promise<XrpcResult> {
	const contentType = response.headers.get("Content-Type") ?? "";
	let json: unknown;
	let error: string | undefined;
	if (contentType.includes("application/json")) {
		json = await response
			.clone()
			.json()
			.catch(() => undefined);
		if (json && typeof json === "object" && "error" in json) {
			error = String((json as { error: unknown }).error);
		}
	}
	return {
		status: response.status,
		json,
		error,
		headers: response.headers,
		response,
	};
}

/** GET an XRPC query. `headers` may carry auth. */
export async function xrpcGet(
	ctx: CheckContext,
	nsid: string,
	params?: Record<string, string | undefined>,
	headers?: HeadersInit,
): Promise<XrpcResult> {
	const response = await ctx.fetch(xrpcUrl(ctx.target.origin, nsid, params), {
		method: "GET",
		headers,
	});
	return toResult(response);
}

/** POST an XRPC procedure with a JSON body. */
export async function xrpcPost(
	ctx: CheckContext,
	nsid: string,
	body: unknown,
	headers?: HeadersInit,
): Promise<XrpcResult> {
	const merged = new Headers(headers);
	merged.set("Content-Type", "application/json");
	const response = await ctx.fetch(xrpcUrl(ctx.target.origin, nsid), {
		method: "POST",
		headers: merged,
		body: JSON.stringify(body),
	});
	return toResult(response);
}

/** Add the operator's auth to a headers object, if a session is present. */
export async function operatorHeaders(
	ctx: CheckContext,
	extra?: HeadersInit,
): Promise<Headers> {
	const headers = new Headers(extra);
	if (ctx.operator?.authorize) {
		await ctx.operator.authorize({ headers });
	}
	return headers;
}

/**
 * A fetch that carries the operator's credentials: the operator's own
 * signing fetch when it has one (a DPoP-bound OAuth session must sign each
 * request individually), otherwise the transport fetch with
 * `authorize`-injected headers. With no operator at all it falls back to
 * the plain transport — the runner skips operator-needing checks then, so
 * that path is only reached by checks that can also run anonymously.
 */
export function operatorFetch(ctx: CheckContext): typeof fetch {
	const operator = ctx.operator;
	if (!operator) return ctx.fetch;
	if (operator.fetch) return operator.fetch;
	const baseFetch = ctx.fetch;
	return async (input, init) => {
		const headers = new Headers(init?.headers);
		await operator.authorize?.({ ...init, headers });
		return baseFetch(input, { ...init, headers });
	};
}

/**
 * The same context with the operator's credentials on `fetch`, so a check
 * can write `xrpcGet(asOperator(ctx), …)` for authenticated calls while
 * keeping the bare `ctx` for requests that must stay anonymous.
 */
export function asOperator(ctx: CheckContext): CheckContext {
	return { ...ctx, fetch: operatorFetch(ctx) };
}
