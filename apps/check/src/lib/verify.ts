import * as CAR from '@atcute/car';
import * as CBOR from '@atcute/cbor';
import type { Bytes } from '@atcute/cbor';
import { fromBytes as unwrapBytes } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { getPublicKeyFromDidController, verifySig } from '@atcute/crypto';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
} from '@atcute/identity-resolver';
import { getAtprotoVerificationMaterial, isAtprotoDid, isPlcDid, isWebDid, webDidToDocumentUrl } from '@atcute/identity';

import { isWellFormedCommit } from './types.ts';

export interface VerifyOk {
	ok: true;
	/** the deserialized commit object, for debug display (may carry unexpected fields) */
	commit: Record<string, unknown>;
	/** the signing key actually resolved for the commit's DID */
	publicKey: { type: string; jwtAlg: string; publicKeyMultibase: string };
	/** did the signature verify against the resolved key? */
	signatureValid: boolean;
	/** the commit's DID, for the link-out */
	did: string;
	/** a human-viewable URL for the DID document the key was resolved from */
	didDocUrl: string;
	/** raw bytes of the commit block (as stored in the CAR), for copying to a CBOR debugger */
	commitBytes: Uint8Array;
}

/** shape we surface to the UI: material from the DID doc + jwtAlg from the parsed key */
interface ResolvedKey {
	type: string;
	jwtAlg: string;
	publicKeyMultibase: string;
}

export interface VerifyErr {
	ok: false;
	/** stage that failed, for a faithful error report */
	stage: 'parse' | 'resolve' | 'verify' | 'unknown';
	message: string;
	/** the deserialized commit, if we got far enough to decode it (always offered to the debug view) */
	commit?: Record<string, unknown>;
}

export type VerifyResult = VerifyOk | VerifyErr;

const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver(),
	},
});

/**
 * extract the root commit from a CAR, resolve its DID to a public key, and verify
 * the commit's signature.
 *
 * the signature step mirrors `@atcute/repo`'s `verifyRecord`: strip the `sig`
 * field, re-serialize the remaining fields as dag-cbor, and verify against those
 * bytes. `verifySig` uses `crypto.subtle.verify` (or noble for secp256k1), both
 * of which SHA-256 the data internally — so we pass the raw unsigned-commit bytes
 * and **must not** pre-hash.
 *
 * on failure the decoded commit is still returned (when available) so the debug
 * view can show what was in it.
 */
export const verifyCar = async (carBytes: Uint8Array): Promise<VerifyResult> => {
	let commit: Record<string, unknown>;
	let commitBytes: Uint8Array;
	try {
		const extracted = extractCommit(carBytes);
		commit = extracted.commit;
		commitBytes = extracted.bytes;
	} catch (err) {
		return {
			ok: false,
			stage: 'parse',
			message: err instanceof Error ? err.message : String(err),
		};
	}

	// resolve the DID before any signature work, so a resolution failure is a
	// distinct, faithful report rather than a generic "verification failed".
	let publicKey;
	try {
		publicKey = await resolveKey(commit);
	} catch (err) {
		return {
			ok: false,
			stage: 'resolve',
			message: err instanceof Error ? err.message : String(err),
			commit,
		};
	}

	try {
		const valid = await verifyCommitSignature(commit, publicKey.found);
		return {
			ok: true,
			commit,
			publicKey: publicKey.resolved,
			signatureValid: valid,
			did: publicKey.did,
			didDocUrl: publicKey.didDocUrl,
			commitBytes,
		};
	} catch (err) {
		return {
			ok: false,
			stage: 'verify',
			message: err instanceof Error ? err.message : String(err),
			commit,
		};
	}
};

/** read the CAR root block and decode it as a commit */
const extractCommit = (carBytes: Uint8Array): { commit: Record<string, unknown>; bytes: Uint8Array } => {
	const reader = CAR.fromUint8Array(carBytes);
	const roots = reader.roots;
	if (roots.length < 1) {
		throw new Error(`CAR has no roots; got=${roots.length}`);
	}

	// index every block by CID string; the commit is whatever roots[0] points at
	const blocks = new Map<string, Uint8Array>();
	for (const entry of reader) {
		blocks.set(CID.toString(entry.cid), entry.bytes);
	}

	const rootCid = roots[0].$link;
	const commitBytes = blocks.get(rootCid);
	if (commitBytes === undefined) {
		throw new Error(`root CID not present in CAR blocks; cid=${rootCid}`);
	}

	const decoded = CBOR.decode(commitBytes) as Record<string, unknown>;
	if (decoded === null || typeof decoded !== 'object') {
		throw new Error(`root block did not decode to a map`);
	}

	return { commit: decoded, bytes: commitBytes };
};

/** a human-viewable URL for a DID document (plc.directory for did:plc, well-known for did:web) */
const didDocUrlFor = (did: string): string => {
	if (isPlcDid(did)) {
		return `https://plc.directory/${did}`;
	}
	if (isWebDid(did)) {
		return webDidToDocumentUrl(did).href;
	}
	return '';
};

/** resolve the commit's DID to a public key plus the material we display */
const resolveKey = async (commit: Record<string, unknown>): Promise<{
	found: ReturnType<typeof getPublicKeyFromDidController>;
	resolved: ResolvedKey;
	did: string;
	didDocUrl: string;
}> => {
	const did = commit['did'];
	if (typeof did !== 'string') {
		throw new Error(`commit has no string 'did' field`);
	}
	if (!isAtprotoDid(did)) {
		throw new Error(`commit 'did' is not a supported atproto DID: ${did}`);
	}

	const doc = await didResolver.resolve(did);
	const material = getAtprotoVerificationMaterial(doc);
	if (material === undefined) {
		throw new Error(`DID document has no #atproto verification method`);
	}

	const found = getPublicKeyFromDidController(material);
	return {
		found,
		resolved: { type: found.type, jwtAlg: found.jwtAlg, publicKeyMultibase: material.publicKeyMultibase },
		did,
		didDocUrl: didDocUrlFor(did),
	};
};

/**
 * verify the commit signature: strip `sig`, re-encode, verify against the bytes.
 * the unsigned commit is re-encoded with the same dag-cbor codec the signer used,
 * so the round-trip is faithful (CidLink values round-trip through their tags).
 */
const verifyCommitSignature = async (
	commit: Record<string, unknown>,
	found: ReturnType<typeof getPublicKeyFromDidController>,
): Promise<boolean> => {
	if (!isWellFormedCommit(commit)) {
		throw new Error(`commit is not well-formed (missing/invalid fields)`);
	}

	const { sig, ...unsigned } = commit;
	const sigBytes = unwrapBytes(sig as Bytes) as Uint8Array<ArrayBuffer>;
	const data = CBOR.encode(unsigned) as Uint8Array<ArrayBuffer>;

	return await verifySig(found, sigBytes, data);
};
