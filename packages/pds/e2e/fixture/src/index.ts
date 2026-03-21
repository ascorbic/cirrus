export { AccountDurableObject } from "@fidis/pds";
import type { PDSEnv } from "@fidis/pds";
import pds from "@fidis/pds";

/**
 * Wrap the PDS worker to add test-only endpoints for e2e testing.
 */
export default {
	async fetch(
		request: Request,
		env: PDSEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Test-only: health check
		if (url.pathname === "/__test/ping") {
			return new Response("pong");
		}

		// Test-only: seed an account without Farcaster auth.
		// Expects { fid, signingKey, signingKeyPublic } in the request body.
		if (url.pathname === "/__test/seed" && request.method === "POST") {
			try {
				const body = (await request.json()) as {
					fid: string;
					signingKey: string;
					signingKeyPublic: string;
				};
				const domain = env.WEBFID_DOMAIN;
				const did = `did:web:${body.fid}.${domain}`;
				const handle = `${body.fid}.${domain}`;

				const accountDO = env.ACCOUNT.get(env.ACCOUNT.idFromName(did));

				// Check if already seeded
				const existing = await accountDO.rpcGetAtprotoDid();
				if (existing) {
					return Response.json({ did, handle, seeded: false });
				}

				await accountDO.rpcSetAtprotoIdentity({
					did,
					handle,
					signingKey: body.signingKey,
					signingKeyPublic: body.signingKeyPublic,
				});

				return Response.json({ did, handle, seeded: true });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : "Seed failed" },
					{ status: 500 },
				);
			}
		}

		// Test-only: delete an account.
		// Expects { fid } in the request body.
		if (url.pathname === "/__test/delete" && request.method === "POST") {
			try {
				const body = (await request.json()) as { fid: string };
				const domain = env.WEBFID_DOMAIN;
				const did = `did:web:${body.fid}.${domain}`;
				const accountDO = env.ACCOUNT.get(env.ACCOUNT.idFromName(did));
				await accountDO.rpcDeleteRepo();
				return Response.json({ did, deleted: true });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : "Delete failed" },
					{ status: 500 },
				);
			}
		}

		// In Vite dev, the request URL hostname is always localhost:PORT.
		// The PDS routes by hostname (NNN.domain), so we rewrite the URL
		// using the X-Test-Host header to simulate subdomain routing.
		const testHost = request.headers.get("X-Test-Host");
		if (testHost) {
			const rewritten = new URL(request.url);
			const [host, port] = testHost.split(":");
			rewritten.hostname = host!;
			if (port) rewritten.port = port;
			request = new Request(rewritten.toString(), request);
		}

		return pds.fetch(request, env, ctx);
	},
};
