/**
 * Boots the atproto reference PDS in-process (via @atproto/dev-env) and
 * returns everything the conformance suite needs to point at it: the origin,
 * an operator account DID, and a full-access session token.
 *
 * dev-env starts a real PLC plus the reference `@atproto/pds` (the same code
 * every hosted atproto PDS runs), backed by SQLite — so this is the reference
 * implementation, not a mock. Accounts are did:plc and the PDS is
 * multi-tenant, which is exactly why it is a good calibration target: the
 * suite must not smuggle in assumptions specific to a single-tenant did:web
 * host like Cirrus.
 */

import { TestNetworkNoAppView } from "@atproto/dev-env";

export interface ReferencePds {
	/** Public origin of the reference PDS, e.g. http://localhost:2583 */
	origin: string;
	/** The operator account's DID (did:plc). */
	operatorDid: string;
	/** A full-access session token for the operator account. */
	operatorToken: string;
	/** Tear down the PLC and PDS servers. */
	close(): Promise<void>;
}

export async function startReferencePds(): Promise<ReferencePds> {
	const network = await TestNetworkNoAppView.create();
	try {
		const seed = network.getSeedClient();
		// The handle is cosmetic — only the DID and token drive the suite.
		// `.test` is dev-env's user domain; the reference rejects longer or
		// reserved labels, so keep it short and generic.
		const operator = await seed.createAccount("operator", {
			handle: "alice.test",
			email: "operator@conformance.test",
			password: "conformance-operator-pw",
		});
		return {
			origin: network.pds.url,
			operatorDid: operator.did,
			operatorToken: operator.accessJwt,
			close: () => network.close(),
		};
	} catch (err) {
		await network.close();
		throw err;
	}
}
