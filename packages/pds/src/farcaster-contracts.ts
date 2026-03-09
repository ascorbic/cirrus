/**
 * Farcaster contract interactions via viem.
 *
 * Reads Farcaster IdRegistry on Optimism to verify FID ownership.
 */

import { createPublicClient, http, type Address } from "viem";
import { optimism } from "viem/chains";

/** Farcaster IdRegistry contract on Optimism mainnet */
const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b" as const;

/** Minimal ABI fragment for custodyOf(uint256) → address */
const idRegistryAbi = [
	{
		name: "custodyOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "fid", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		name: "idOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

/**
 * Get the custody address for a Farcaster FID from the IdRegistry on Optimism.
 *
 * @param fid - The Farcaster ID (numeric string)
 * @param rpcUrl - Optimism RPC endpoint URL
 * @returns The custody address (checksummed)
 */
export async function getCustodyAddress(
	fid: string,
	rpcUrl: string,
): Promise<string> {
	const client = createPublicClient({
		chain: optimism,
		transport: http(rpcUrl),
	});

	const address = await client.readContract({
		address: ID_REGISTRY,
		abi: idRegistryAbi,
		functionName: "custodyOf",
		args: [BigInt(fid)],
	});

	return address;
}

/**
 * Get the FID for an address from the IdRegistry on Optimism.
 * Returns null if the address has no registered FID.
 *
 * @param address - Ethereum address to look up
 * @param rpcUrl - Optimism RPC endpoint URL
 * @returns The FID as a string, or null if not found
 */
export async function getFidForAddress(
	address: string,
	rpcUrl: string,
): Promise<string | null> {
	const client = createPublicClient({
		chain: optimism,
		transport: http(rpcUrl),
	});

	const fid = await client.readContract({
		address: ID_REGISTRY,
		abi: idRegistryAbi,
		functionName: "idOf",
		args: [address as Address],
	});

	// idOf returns 0 for unregistered addresses
	if (fid === 0n) return null;
	return fid.toString();
}
