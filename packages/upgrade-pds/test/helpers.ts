export function requestUrl(input: Parameters<typeof fetch>[0]): URL {
	return new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
}

export function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
