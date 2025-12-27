/**
 * Type declarations for packages with exports resolution issues
 * These packages have proper type definitions but their package.json exports
 * don't properly expose them for TypeScript's module resolution.
 */

declare module "multiformats/cid" {
	import type { Version, CID as CIDType } from "multiformats/types/src/cid";

	export class CID<
		Data = unknown,
		Code extends number = number,
		Alg extends number = number,
		Ver extends Version = Version,
	> implements CIDType<Data, Code, Alg, Ver> {
		static parse(source: string | Uint8Array): CID;
		static decode(bytes: Uint8Array): CID;
		static create<T = unknown>(
			version: Version,
			code: number,
			hash: any,
		): CID<T>;
		readonly bytes: Uint8Array;
		readonly code: Code;
		readonly multihash: any;
		readonly version: Ver;
		toString(): string;
		toV0(): CID;
		toV1(): CID;
		equals(other: any): boolean;
		toJSON(): any;
	}

	export type { Version, CIDType };
}

declare module "@ipld/dag-cbor" {
	export const code: number;
	export function encode(obj: any): Uint8Array;
	export function decode<T = any>(bytes: Uint8Array): T;
}

declare module "uint8arrays" {
	export function concat(arrays: Uint8Array[], length?: number): Uint8Array;
	export function equals(a: Uint8Array, b: Uint8Array): boolean;
	export function toString(array: Uint8Array, encoding?: string): string;
	export function fromString(string: string, encoding?: string): Uint8Array;
}

declare module "multiformats/hashes/sha2" {
	export interface MultihashDigest {
		readonly bytes: Uint8Array;
		readonly code: number;
		readonly size: number;
		readonly digest: Uint8Array;
	}

	export const sha256: {
		digest(data: Uint8Array): Promise<MultihashDigest>;
	};

	export const sha512: {
		digest(data: Uint8Array): Promise<MultihashDigest>;
	};
}
