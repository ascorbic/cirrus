/**
 * Record preparation and serialization for the Worker side of the write
 * and read paths. Records are stored as dag-cbor bytes with their CID,
 * computed here — the same encoding path the reference uses.
 */

import { encode, decode, cidForLex } from "@atproto/lex-cbor";
import { enumBlobRefs, getBlobCidString } from "@atproto/lex-data";
import type { LexValue } from "@atproto/lex-data";
import { jsonToLex, lexToJson } from "@atproto/lex-json";
import type { JsonValue } from "@atproto/lex-json";

export interface PreparedRecord {
	cid: string;
	bytes: Uint8Array;
	blobCids: string[];
	/** The lex-normalised record, for echoing back in responses. */
	json: unknown;
}

/**
 * Convert a client-supplied JSON record into its stored form: lex value →
 * dag-cbor bytes → CID, with blob references enumerated for the space's
 * blob tracking.
 */
export async function prepareRecord(record: unknown): Promise<PreparedRecord> {
	const lex = jsonToLex(record as JsonValue) as LexValue;
	const bytes = encode(lex);
	const cid = await cidForLex(lex);
	const blobCids: string[] = [];
	for (const ref of enumBlobRefs(lex)) {
		blobCids.push(getBlobCidString(ref));
	}
	return { cid: cid.toString(), bytes, blobCids, json: lexToJson(lex) };
}

/** Decode stored record bytes back into response JSON. */
export function recordBytesToJson(bytes: Uint8Array): unknown {
	return lexToJson(decode(bytes));
}
