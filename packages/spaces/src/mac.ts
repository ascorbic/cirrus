/**
 * Commits and MACs.
 *
 * A space repo commit carries no signature. A syncer authenticates what a
 * repo host serves with a MAC instead: an HTTP message signature (RFC 9421)
 * using `hmac-sha256`, keyed by a per-request secret both sides derive with
 * HPKE secret export against the account's `#atproto_kem` key. The syncer
 * asks with `Accept-Signature`, naming its ephemeral key and a profile tag;
 * the host answers with a header describing the commit or record
 * (`Atproto-Space-Commit` / `Atproto-Space-Record`) and a MAC covering it.
 * A leaked response proves nothing to a third party. The KEM key is the only
 * secret here, and it lives with the Worker.
 */

import {
	COMMIT_MAC_PROFILE,
	MAC_COVERED_HEADER,
	RECORD_MAC_PROFILE,
	RepoCommit,
	SpaceKemError,
	SpaceMacError,
	createCommitMacHeaders,
	createRecordMacHeaders,
	decapsulate,
	parseMacRequest,
} from "@atproto/space";
import type { CreateMacParams, MacProfile } from "@atproto/space";
import { P256Keypair } from "@atproto/crypto";
import { parseCid, toBase64 } from "@atproto/lex-data";
import { SpaceError } from "./errors.js";
import type { RepoState } from "./types.js";

export { COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE };
export type { MacProfile };

/** The MAC profiles, as plain strings for the public API. */
export type SpaceMacProfile = "atproto-space-commit" | "atproto-space-record";

/** The request header a syncer asks for a MAC with. */
export const MAC_REQUEST_HEADER = "accept-signature";

/** The response headers a browser syncer must read to check a MAC. */
export function macExposedHeaders(profile: SpaceMacProfile): string[] {
	return [
		MAC_COVERED_HEADER[profile as MacProfile],
		"signature-input",
		"signature",
	];
}

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
		rev: params.state.rev as never,
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

export interface MacRequestInput {
	/** The `Accept-Signature` request header, if any. */
	acceptSignature: string | undefined;
	/** Whether the request was authorised by a space credential. */
	credential: boolean;
	profile: MacProfile;
	getKemKeypair: () => Promise<P256Keypair | null>;
}

/** What a MAC is computed with, once requested and decapsulated. */
export type MacParams = CreateMacParams;

/**
 * The MAC owed by a read that returns a commit or record. A space
 * credential must ask for one with the profile's tag; an account reading its
 * own data gets one only if it asks. Requests with other tags are ignored.
 * Returns undefined when no MAC is owed.
 */
export async function macRequest(
	req: MacRequestInput,
): Promise<MacParams | undefined> {
	let request;
	try {
		request = parseMacRequest(req.acceptSignature, req.profile);
	} catch (err) {
		throw invalidMac(err);
	}
	if (!request) {
		if (!req.credential) return undefined;
		throw new SpaceError(
			"InvalidSpaceMac",
			`A MAC must be requested with tag "${req.profile}"`,
		);
	}
	const keypair = await req.getKemKeypair();
	if (!keypair) {
		throw new SpaceError(
			"KemKeyUnavailable",
			"This host has no #atproto_kem key configured, so it cannot authenticate space data to syncers",
		);
	}
	try {
		return { ...request, sharedSecret: decapsulate(keypair, request.keyShare) };
	} catch (err) {
		throw invalidMac(err);
	}
}

function invalidMac(err: unknown): SpaceError {
	if (err instanceof SpaceMacError || err instanceof SpaceKemError) {
		return new SpaceError("InvalidSpaceMac", err.message);
	}
	return new SpaceError("InvalidSpaceMac", "Invalid Accept-Signature header");
}

/** The MAC response headers for a commit, when one is owed. */
export function commitMacHeaders(
	mac: MacParams | undefined,
	commit: SpaceCommit,
): Record<string, string> {
	if (!mac) return {};
	return createCommitMacHeaders(
		commit as Parameters<typeof createCommitMacHeaders>[0],
		mac,
	).headers;
}

/** The MAC response headers for a record, when one is owed. */
export function recordMacHeaders(
	mac: MacParams | undefined,
	uri: string,
	cid: string,
): Record<string, string> {
	if (!mac) return {};
	return createRecordMacHeaders(uri as never, parseCid(cid), mac).headers;
}
