import { describe, it, expect, beforeEach } from "vitest";
import {
	authenticateClient,
	verifyClientAssertion,
	parseClientAssertion,
	ClientAuthError,
	JWT_BEARER_ASSERTION_TYPE,
} from "../src/client-auth.js";
import type { ClientMetadata, JWK } from "../src/storage.js";
import { generateClientKeyPair, createClientAssertion } from "./helpers.js";

describe("Client Authentication", () => {
	const issuer = "https://pds.example.com";
	const tokenEndpoint = `${issuer}/oauth/token`;
	const usedNonces = new Set<string>();

	function checkJti(jti: string): Promise<boolean> {
		if (usedNonces.has(jti)) {
			return Promise.resolve(false);
		}
		usedNonces.add(jti);
		return Promise.resolve(true);
	}

	beforeEach(() => {
		usedNonces.clear();
	});

	describe("parseClientAssertion", () => {
		it("extracts assertion type and assertion from params", () => {
			const params = {
				client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
				client_assertion: "test.jwt.token",
			};

			const result = parseClientAssertion(params);

			expect(result.assertionType).toBe(JWT_BEARER_ASSERTION_TYPE);
			expect(result.assertion).toBe("test.jwt.token");
		});

		it("returns undefined for missing fields", () => {
			const result = parseClientAssertion({});

			expect(result.assertionType).toBeUndefined();
			expect(result.assertion).toBeUndefined();
		});
	});

	describe("verifyClientAssertion", () => {
		let clientKeyPair: Awaited<ReturnType<typeof generateClientKeyPair>>;
		let confidentialClient: ClientMetadata;

		beforeEach(async () => {
			clientKeyPair = await generateClientKeyPair("ES256", "key-1");
			confidentialClient = {
				clientId: "did:web:confidential-client.example.com",
				clientName: "Confidential Client",
				redirectUris: ["https://confidential-client.example.com/callback"],
				tokenEndpointAuthMethod: "private_key_jwt",
				jwks: {
					keys: [clientKeyPair.publicJwk as JWK],
				},
			};
		});

		it("verifies a valid client assertion", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			const payload = await verifyClientAssertion(
				assertion,
				confidentialClient,
				{
					tokenEndpoint,
					issuer,
					checkJti,
				},
			);

			expect(payload.iss).toBe(confidentialClient.clientId);
			expect(payload.sub).toBe(confidentialClient.clientId);
		});

		it("accepts issuer URL as audience (not just token endpoint)", async () => {
			// Some clients (like leaflet.pub) send the issuer as audience instead of token endpoint
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: issuer, // Just the issuer, not the token endpoint
				},
				clientKeyPair.publicJwk,
			);

			const payload = await verifyClientAssertion(
				assertion,
				confidentialClient,
				{
					tokenEndpoint,
					issuer,
					checkJti,
				},
			);

			expect(payload.iss).toBe(confidentialClient.clientId);
			expect(payload.aud).toBe(issuer);
		});

		it("rejects assertion with wrong issuer", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: "did:web:wrong-issuer.example.com",
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				verifyClientAssertion(assertion, confidentialClient, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(ClientAuthError);
		});

		it("rejects assertion with wrong subject", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: "did:web:wrong-subject.example.com",
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				verifyClientAssertion(assertion, confidentialClient, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(ClientAuthError);
		});

		it("rejects assertion with wrong audience", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: "https://wrong-endpoint.example.com/oauth/token",
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				verifyClientAssertion(assertion, confidentialClient, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(ClientAuthError);
		});

		it("accepts audience as array containing token endpoint", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: [tokenEndpoint, "https://other.example.com"],
				},
				clientKeyPair.publicJwk,
			);

			const payload = await verifyClientAssertion(
				assertion,
				confidentialClient,
				{
					tokenEndpoint,
					issuer,
					checkJti,
				},
			);

			expect(payload.iss).toBe(confidentialClient.clientId);
		});

		it("rejects replayed assertions (same jti)", async () => {
			const jti = "unique-jti-12345";

			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
					jti,
				},
				clientKeyPair.publicJwk,
			);

			// First use should succeed
			await verifyClientAssertion(assertion, confidentialClient, {
				tokenEndpoint,
				issuer,
				checkJti,
			});

			// Second use should fail (replay)
			await expect(
				verifyClientAssertion(assertion, confidentialClient, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(/replay/i);
		});

		it("rejects assertion signed with wrong key", async () => {
			const wrongKeyPair = await generateClientKeyPair("ES256");

			const assertion = await createClientAssertion(
				wrongKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
				},
				wrongKeyPair.publicJwk,
			);

			await expect(
				verifyClientAssertion(assertion, confidentialClient, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(ClientAuthError);
		});

		it("rejects client with no JWKS", async () => {
			const clientWithoutJwks: ClientMetadata = {
				...confidentialClient,
				jwks: undefined,
				jwksUri: undefined,
			};

			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: clientWithoutJwks.clientId,
					sub: clientWithoutJwks.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				verifyClientAssertion(assertion, clientWithoutJwks, {
					tokenEndpoint,
					issuer,
					checkJti,
				}),
			).rejects.toThrow(/JWKS/i);
		});
	});

	describe("authenticateClient", () => {
		let clientKeyPair: Awaited<ReturnType<typeof generateClientKeyPair>>;
		let publicClient: ClientMetadata;
		let confidentialClient: ClientMetadata;

		beforeEach(async () => {
			clientKeyPair = await generateClientKeyPair("ES256", "key-1");

			publicClient = {
				clientId: "did:web:public-client.example.com",
				clientName: "Public Client",
				redirectUris: ["https://public-client.example.com/callback"],
				tokenEndpointAuthMethod: "none",
			};

			confidentialClient = {
				clientId: "did:web:confidential-client.example.com",
				clientName: "Confidential Client",
				redirectUris: ["https://confidential-client.example.com/callback"],
				tokenEndpointAuthMethod: "private_key_jwt",
				jwks: {
					keys: [clientKeyPair.publicJwk as JWK],
				},
			};
		});

		async function getClient(clientId: string): Promise<ClientMetadata | null> {
			if (clientId === publicClient.clientId) return publicClient;
			if (clientId === confidentialClient.clientId) return confidentialClient;
			return null;
		}

		it("allows public client without assertion", async () => {
			const result = await authenticateClient(
				{ client_id: publicClient.clientId },
				getClient,
				{ tokenEndpoint, issuer, checkJti },
			);

			expect(result.authenticated).toBe(false);
			expect(result.clientId).toBe(publicClient.clientId);
		});

		it("rejects public client with assertion", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: publicClient.clientId,
					sub: publicClient.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				authenticateClient(
					{
						client_id: publicClient.clientId,
						client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
						client_assertion: assertion,
					},
					getClient,
					{ tokenEndpoint, issuer, checkJti },
				),
			).rejects.toThrow(/not expected/i);
		});

		it("requires assertion for confidential client", async () => {
			await expect(
				authenticateClient(
					{ client_id: confidentialClient.clientId },
					getClient,
					{ tokenEndpoint, issuer, checkJti },
				),
			).rejects.toThrow(/required/i);
		});

		it("authenticates confidential client with valid assertion", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			const result = await authenticateClient(
				{
					client_id: confidentialClient.clientId,
					client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
					client_assertion: assertion,
				},
				getClient,
				{ tokenEndpoint, issuer, checkJti },
			);

			expect(result.authenticated).toBe(true);
			expect(result.clientId).toBe(confidentialClient.clientId);
		});

		it("rejects unknown assertion type", async () => {
			const assertion = await createClientAssertion(
				clientKeyPair.privateKey,
				{
					iss: confidentialClient.clientId,
					sub: confidentialClient.clientId,
					aud: tokenEndpoint,
				},
				clientKeyPair.publicJwk,
			);

			await expect(
				authenticateClient(
					{
						client_id: confidentialClient.clientId,
						client_assertion_type: "wrong:assertion:type",
						client_assertion: assertion,
					},
					getClient,
					{ tokenEndpoint, issuer, checkJti },
				),
			).rejects.toThrow(/Unsupported assertion type/i);
		});

		it("rejects unknown client", async () => {
			await expect(
				authenticateClient(
					{ client_id: "did:web:unknown.example.com" },
					getClient,
					{ tokenEndpoint, issuer, checkJti },
				),
			).rejects.toThrow(/Unknown client/i);
		});

		it("requires client_id", async () => {
			await expect(
				authenticateClient({}, getClient, { tokenEndpoint, issuer, checkJti }),
			).rejects.toThrow(/Missing client_id/i);
		});
	});
});
