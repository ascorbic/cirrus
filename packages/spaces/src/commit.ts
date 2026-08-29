/**
 * Commit signing.
 *
 * Signing happens in the Worker, never in the Durable Object. The proposal
 * requires a fresh `ikm` per reader, so a signature is never stored — each
 * response that carries a commit signs the persisted LtHash state anew with
 * the account keypair the Worker already holds.
 */

import { RepoCommit } from "@atproto/space";
import type { SignedCommit } from "@atproto/space";
import type { Keypair } from "@atproto/crypto";
import { toBase64 } from "@atproto/lex-data";
import type { RepoState } from "./types.js";

export interface SignCommitParams {
	spaceUri: string;
	/** The repo author (the operator DID for every repo Cirrus serves). */
	author: string;
	state: RepoState;
}

export async function signCommit(
	params: SignCommitParams,
	keypair: Keypair,
): Promise<SignedCommit> {
	return RepoCommit.fromState(params.state.setHash).sign(
		{
			space: params.spaceUri,
			author: params.author,
			rev: params.state.rev,
		},
		keypair,
	);
}

/**
 * Lexicon JSON form of a signed commit (`com.atproto.space.defs#signedCommit`):
 * bytes fields encode as `{"$bytes": "<base64>"}`.
 */
export function commitToJson(commit: SignedCommit): Record<string, unknown> {
	return {
		ver: commit.ver,
		hash: { $bytes: toBase64(commit.hash) },
		ikm: { $bytes: toBase64(commit.ikm) },
		sig: { $bytes: toBase64(commit.sig) },
		mac: { $bytes: toBase64(commit.mac) },
		rev: commit.rev,
	};
}

/** Lexicon JSON form of a bare bytes value. */
export function bytesToJson(bytes: Uint8Array): { $bytes: string } {
	return { $bytes: toBase64(bytes) };
}
