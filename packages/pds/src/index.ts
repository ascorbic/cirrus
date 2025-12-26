export { SqliteRepoStorage } from "./storage"
export { AccountDurableObject } from "./account-do"
export type { Env } from "./env"

// Default export for Cloudflare Workers
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		// DID document for did:web resolution
		if (url.pathname === "/.well-known/did.json") {
			const didDocument = {
				"@context": [
					"https://www.w3.org/ns/did/v1",
					"https://w3id.org/security/multikey/v1",
					"https://w3id.org/security/suites/secp256k1-2019/v1",
				],
				id: env.DID,
				verificationMethod: [
					{
						id: `${env.DID}#atproto`,
						type: "Multikey",
						controller: env.DID,
						publicKeyMultibase: env.SIGNING_KEY_PUBLIC,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: `https://${env.PDS_HOSTNAME}`,
					},
				],
			}
			return new Response(JSON.stringify(didDocument, null, 2), {
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			})
		}

		// Route to Account DO for XRPC endpoints
		if (url.pathname.startsWith("/xrpc/")) {
			const id = env.ACCOUNT.idFromName("account")
			const stub = env.ACCOUNT.get(id)
			return stub.fetch(request)
		}

		// Health check
		if (url.pathname === "/health") {
			return new Response("ok")
		}

		return new Response("Not found", { status: 404 })
	},
}

// Re-export Env type for external use
import type { Env } from "./env"
export type { Env as WorkerEnv }
