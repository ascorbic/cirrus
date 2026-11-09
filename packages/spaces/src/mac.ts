/**
 * Commits and MACs.
 *
 * A space repo commit carries no signature. A syncer authenticates what a
 * repo host serves with a MAC instead: it sends an ephemeral P-256 key share
 * in `Atproto-Space-Want-Mac`, both sides derive a shared secret by ECDH
 * against the account's `#atproto_kem` key, and the host returns an HMAC in
 * `Atproto-Space-Mac`. A leaked response therefore proves nothing to a third
 * party. The KEM key is the only secret here, and it lives with the Worker.
 */

import {
	COMMIT_MAC_TYPE,
	MAC_HEADER as UPSTREAM_MAC_HEADER,
	RECORD_MAC_TYPE,
	RepoCommit,
	SpaceMacError,
	WANT_MAC_HEADER as UPSTREAM_WANT_MAC_HEADER,
	computeCommitMac,
	computeRecordMac,
	decapsulate,
	formatMacHeader,
	parseWantMacHeader,
} from "@atproto/space";
import type { Commit, MacType } from "@atproto/space";
import { P256Keypair } from "@atproto/crypto";
import { parseCid, toBase64 } from "@atproto/lex-data";
import { SpaceError } from "./errors.js";
import type { RepoState } from "./types.js";

export { COMMIT_MAC_TYPE, RECORD_MAC_TYPE };
export type { MacType };

/** The request header a syncer asks for a MAC with. */
export const WANT_MAC_HEADER: string = UPSTREAM_WANT_MAC_HEADER;
/** The response header carrying the MAC. */
export const MAC_HEADER: string = UPSTREAM_MAC_HEADER;

/** A space repo commit (`com.atproto.space.defs#commit`). */
export interface SpaceCommit {
	ver: number;
	repo: string;
	space: string;
	rev: string;
	/** sha256 digest of the LtHash state. */
	data: Uint8Array;
}

/** The commit over a repo's persisted state. */
export function buildCommit(params: {
	spaceUri: string;
	/** The repo author (the operator DID for every repo Cirrus serves). */
	repo: string;
	state: RepoState;
}): SpaceCommit {
	return RepoCommit.fromState(params.state.setHash).toCommit({
		space: params.spaceUri as never,
		repo: params.repo as never,
		rev: params.state.rev,
	});
}

/**
 * Lexicon JSON form of a commit (`com.atproto.space.defs#commit`): bytes
 * fields encode as `{"$bytes": "<base64>"}`.
 */
export function commitToJson(commit: SpaceCommit): Record<string, unknown> {
	return {
		ver: commit.ver,
		repo: commit.repo,
		space: commit.space,
		rev: commit.rev,
		data: bytesToJson(commit.data),
	};
}

/** Lexicon JSON form of a bare bytes value. */
export function bytesToJson(bytes: Uint8Array): { $bytes: string } {
	return { $bytes: toBase64(bytes) };
}

/** Import the account's `#atproto_kem` keypair from its hex private key. */
export async function importKemKeypair(
	privateKeyHex: string,
): Promise<P256Keypair> {
	return P256Keypair.import(privateKeyHex);
}

/** Generate a fresh `#atproto_kem` keypair. */
export async function generateKemKey(): Promise<{
	privateKeyHex: string;
	/** The public key as a did:key. */
	didKey: string;
	/** The public key multibase, for a DID document verification method. */
	publicKeyMultibase: string;
}> {
	const keypair = await P256Keypair.create({ exportable: true });
	const exported = await keypair.export();
	const didKey = keypair.did();
	return {
		privateKeyHex: Array.from(exported, (b) =>
			b.toString(16).padStart(2, "0"),
		).join(""),
		didKey,
		publicKeyMultibase: didKey.slice("did:key:".length),
	};
}

/** The public half of a KEM private key, as a did:key. */
export async function kemDidKey(privateKeyHex: string): Promise<string> {
	return (await importKemKeypair(privateKeyHex)).did();
}

export interface MacRequest {
	/** The `Atproto-Space-Want-Mac` request header, if any. */
	wantMac: string | undefined;
	/** Whether the request was authorised by a space credential. */
	credential: boolean;
	type: MacType;
	getKemKeypair: () => Promise<P256Keypair | null>;
}

/**
 * The shared secret for a response's MAC. A space credential must ask for
 * one; an account reading its own data gets one only if it asks. Returns
 * undefined when no MAC is owed.
 */
export async function macSecret(
	req: MacRequest,
): Promise<Uint8Array | undefined> {
	if (req.wantMac === undefined && !req.credential) return undefined;
	let keyShare: string;
	try {
		keyShare = parseWantMacHeader(req.wantMac, req.type);
	} catch (err) {
		throw badMac(err);
	}
	const keypair = await req.getKemKeypair();
	if (!keypair) {
		throw new SpaceError(
			"KemKeyUnavailable",
			"This host has no #atproto_kem key configured, so it cannot authenticate space data to syncers",
		);
	}
	try {
		return decapsulate(keypair, keyShare);
	} catch (err) {
		throw badMac(err);
	}
}

function badMac(err: unknown): SpaceError {
	if (err instanceof SpaceMacError) {
		return new SpaceError("BadSpaceMac", err.message);
	}
	return new SpaceError("BadSpaceMac", "Invalid Atproto-Space-Want-Mac header");
}

/** The `Atproto-Space-Mac` header for a commit, when a MAC is owed. */
export function commitMacHeaders(
	secret: Uint8Array | undefined,
	commit: SpaceCommit,
): Record<string, string> {
	if (!secret) return {};
	return {
		[MAC_HEADER]: formatMacHeader(
			COMMIT_MAC_TYPE,
			computeCommitMac(secret, commit as Commit),
		),
	};
}

/** The `Atproto-Space-Mac` header for a record, when a MAC is owed. */
export function recordMacHeaders(
	secret: Uint8Array | undefined,
	uri: string,
	cid: string,
): Record<string, string> {
	if (!secret) return {};
	return {
		[MAC_HEADER]: formatMacHeader(
			RECORD_MAC_TYPE,
			computeRecordMac(secret, uri, parseCid(cid)),
		),
	};
}
