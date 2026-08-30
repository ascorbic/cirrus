/**
 * The worker in front of the static assets. Its one job is
 * `/client-metadata.json`: atproto requires a client's metadata document's
 * `client_id` to be exactly the URL the authorization server fetched it
 * from, so a static file hard-coded to the production origin breaks
 * sign-in on every other origin — preview deployments
 * (`*-pdscheck.ascorbic.workers.dev`) in particular. Deriving the document
 * from the request origin makes any origin this worker serves a valid
 * OAuth client of itself.
 *
 * Everything else falls through to the asset store, which keeps the
 * configured single-page-application fallback for SPA routes.
 */

interface Env {
	ASSETS: { fetch: typeof fetch };
}

function clientMetadata(origin: string): Record<string, unknown> {
	return {
		client_id: `${origin}/client-metadata.json`,
		client_name: "check · a PDS validator",
		client_uri: origin,
		redirect_uris: [
			`${origin}/oauth/callback`,
			`${origin}/oauth/flow-callback`,
		],
		// Keep in sync with the scopes the app's flows request (lib/oauth.ts):
		// the write tests, the OAuth conformance flow, and the spaces
		// conformance run each request a subset of this registration.
		scope:
			"atproto transition:generic repo:earth.cirrus.check.testrecord include:site.standard.authFull space:app.bsky.group?collection=*&manage=create&manage=update&manage=delete",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		application_type: "web",
		token_endpoint_auth_method: "none",
		dpop_bound_access_tokens: true,
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/client-metadata.json") {
			return Response.json(clientMetadata(url.origin), {
				headers: {
					// The AS fetches this server-to-server; permissive CORS also
					// lets debugging tools read it from anywhere.
					"Access-Control-Allow-Origin": "*",
					"Cache-Control": "public, max-age=300",
				},
			});
		}
		return env.ASSETS.fetch(request);
	},
};
