/**
 * Test fixture worker: concrete Durable Object subclasses supplying host
 * configuration, simulating how a host PDS embeds the engine. The host
 * config deliberately uses a DID with no account attached anywhere —
 * exercising the S9 requirement that the engine takes its identity from
 * the caller rather than the environment.
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import { SpaceDurableObject, SpaceIndexDurableObject } from "../../../src/index";
import type { SpaceHostConfig } from "../../../src/index";

/** Deterministic test signing key (hex-encoded secp256k1 private key). */
export const TEST_SIGNING_KEY =
	"e5b452e70de7fb7864fdd7f0d67c6dbd0f128413a1daa1b2b8a871e906fc90cc";

export const TEST_OPERATOR_DID = "did:web:operator.test";

/** Deterministic test `#atproto_kem` key (hex-encoded P-256 private key). */
export const TEST_KEM_KEY =
	"b5952836830a94fa65c83db8c527ff76b99d69ed1ceffaa6de93d6a62df1efb5";

let keypairPromise: Promise<Secp256k1Keypair> | null = null;

export class TestSpaceDurableObject extends SpaceDurableObject {
	protected getHostConfig(): SpaceHostConfig {
		return {
			operatorDid: TEST_OPERATOR_DID,
			getKeypair: () => {
				keypairPromise ??= Secp256k1Keypair.import(TEST_SIGNING_KEY);
				return keypairPromise;
			},
		};
	}
}

export class TestSpaceIndexDurableObject extends SpaceIndexDurableObject {}

export default {
	fetch(): Response {
		return new Response("ok");
	},
};
