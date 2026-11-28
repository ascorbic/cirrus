/**
 * Harness identities.
 *
 * Multi-party checks need the harness to play parties that aren't the
 * target's operator: a reader (signing delegation tokens), a writer's PDS
 * (signing notifyWrite service auth) and a foreign space authority
 * (signing credentials and revocations). Each needs a DID the target can
 * resolve to the key the harness holds.
 *
 * Resolution is the caller's to arrange — it can't be solved in-library:
 *
 * - In an in-process fixture, wire the target's DID resolver to
 *   {@link KeypairIdentityProvider.didDocument} (or to `didKey` for a
 *   did:key-only resolver).
 * - Against a live target, publish each identity: serve
 *   {@link KeypairIdentityProvider.didDocument} at a did:web the target
 *   can fetch (the reference matrix runs one tiny server per identity on
 *   `did:web:localhost%3A<port>`), or register a did:plc.
 *
 * What a published identity document must carry, per the alpha: a
 * `#atproto` verification method (it signs every space token and service
 * JWT) and — for an identity that receives calls, such as a syncer inbox
 * or a managing app — an `#atproto_pds` service, which is how a bare DID
 * service identifier resolves to an endpoint. Identities never serve
 * repos, so they publish no `#atproto_kem`.
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import type { HarnessIdentity, IdentityProvider } from "./model.js";

// Credential keys are WebCrypto and browser-safe, so they live in
// ./space-auth.ts; re-exported here for the full entry's callers.
export { createCredentialKey } from "./space-auth.js";
export type { CredentialKey } from "./space-auth.js";

export interface HarnessIdentityWithKey extends HarnessIdentity {
	/** The did:key form of the identity's `#atproto` key, for resolver wiring. */
	didKey: string;
}

export interface IdentityDocumentOptions {
	/** Publish an `#atproto_pds` service at this endpoint (inboxes, managing apps). */
	serviceEndpoint?: string;
	/** A handle to list in `alsoKnownAs`. */
	handle?: string;
}

/**
 * An identity provider backed by secp256k1 keypairs. Identities are keyed
 * by role label and reused within a run, so "reader" is stable across the
 * checks that mint and then present its tokens.
 *
 * `didFor` gives each identity a resolvable DID (e.g.
 * `did:web:localhost%3A61234`), and may be async — a harness can start the
 * server that will publish the document there. When omitted, the
 * identity's DID is its own `did:key`, which only works against a target
 * whose resolver this provider is wired into.
 */
export class KeypairIdentityProvider implements IdentityProvider {
	private cache = new Map<string, Promise<HarnessIdentityWithKey>>();

	constructor(
		private readonly didFor?: (
			role: string,
			didKey: string,
		) => string | Promise<string>,
	) {}

	identity(role: string): Promise<HarnessIdentityWithKey> {
		let existing = this.cache.get(role);
		if (!existing) {
			existing = this.mint(role);
			this.cache.set(role, existing);
		}
		return existing;
	}

	private async mint(role: string): Promise<HarnessIdentityWithKey> {
		const keypair = await Secp256k1Keypair.create({ exportable: true });
		const didKey = keypair.did();
		const did = this.didFor ? await this.didFor(role, didKey) : didKey;
		return {
			did,
			didKey,
			jwtAlg: keypair.jwtAlg,
			sign: (bytes) => keypair.sign(bytes),
		};
	}

	/**
	 * The DID document a resolvable identity must publish: its `#atproto`
	 * key as a Multikey and, optionally, the `#atproto_pds` service the
	 * target delivers to.
	 */
	static didDocument(
		identity: Pick<HarnessIdentityWithKey, "did" | "didKey">,
		opts: IdentityDocumentOptions = {},
	): Record<string, unknown> {
		return {
			"@context": [
				"https://www.w3.org/ns/did/v1",
				"https://w3id.org/security/multikey/v1",
			],
			id: identity.did,
			...(opts.handle ? { alsoKnownAs: [`at://${opts.handle}`] } : {}),
			verificationMethod: [
				{
					id: `${identity.did}#atproto`,
					type: "Multikey",
					controller: identity.did,
					publicKeyMultibase: identity.didKey.slice("did:key:".length),
				},
			],
			...(opts.serviceEndpoint
				? {
						service: [
							{
								id: "#atproto_pds",
								type: "AtprotoPersonalDataServer",
								serviceEndpoint: opts.serviceEndpoint,
							},
						],
					}
				: {}),
		};
	}

	/** All minted identities so far, for resolver wiring in fixtures. */
	minted(): Promise<HarnessIdentityWithKey[]> {
		return Promise.all(this.cache.values());
	}
}
