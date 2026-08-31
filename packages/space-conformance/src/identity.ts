/**
 * Harness identities and DPoP keys.
 *
 * Multi-party checks need the harness to play a reader, a writer and a
 * syncer — parties that aren't the target's operator. Each only needs a
 * DID with a resolvable key the target can verify against, so the provider
 * mints keypairs and the harness signs as those parties.
 *
 * Two facts the caller must arrange (they can't be solved in-library):
 * the target has to be able to *resolve* each identity's DID to its key.
 * In an in-process fixture the caller wires the target's key resolver to
 * this provider's `didKey(role)`; against a live target the identities
 * must be published (did:web under the checker's origin, or did:plc on a
 * reachable directory). The provider is resolution-agnostic — it only
 * holds keys and signs.
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import type { DpopKey, HarnessIdentity, IdentityProvider } from "./model.js";
import { createDpopKey } from "./dpop.js";

// DPoP keys are WebCrypto and browser-safe, so they live in ./dpop.ts;
// re-exported here because the full entry has always offered them.
export { createDpopKey } from "./dpop.js";

export interface HarnessIdentityWithKey extends HarnessIdentity {
	/** The did:key form of the identity's signing key, for resolver wiring. */
	didKey: string;
}

/**
 * An identity provider backed by secp256k1 keypairs. Identities are keyed
 * by role label and reused within a run, so "reader" is stable across the
 * checks that mint and then present its tokens.
 *
 * `didAt` lets the caller give each identity a resolvable DID (e.g.
 * `did:web:checker.test:actors:reader`); when omitted, the identity's DID
 * is its own `did:key`, which only works against a target whose resolver
 * this provider is wired into.
 */
export class KeypairIdentityProvider implements IdentityProvider {
	private cache = new Map<string, Promise<HarnessIdentityWithKey>>();

	constructor(
		private readonly didAt?: (role: string, didKey: string) => string,
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
		const did = this.didAt ? this.didAt(role, didKey) : didKey;
		return {
			did,
			didKey,
			jwtAlg: keypair.jwtAlg,
			sign: (bytes) => keypair.sign(bytes),
		};
	}

	dpopKey(): Promise<DpopKey> {
		return createDpopKey();
	}

	/** All minted identities so far, for resolver wiring in fixtures. */
	minted(): Promise<HarnessIdentityWithKey[]> {
		return Promise.all(this.cache.values());
	}
}
