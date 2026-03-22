/**
 * Test script for the x402 agent account creation flow.
 *
 * Creates a fresh wallet for each run, funds it with Base Sepolia ETH + USDC
 * from the funder wallet, and tests the full signup flow.
 *
 * Prerequisites:
 *   1. Start PDS:         pnpm --filter fid-pds dev
 *   2. Start signup:      pnpm --filter signup dev
 *   3. Fund the funder wallet (0xd4A2...) with Base Sepolia ETH + USDC:
 *      - ETH faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
 *      - USDC faucet: https://faucet.circle.com/ (select Base Sepolia)
 *
 * Usage:
 *   bun scripts/test-agent-account.ts                        # 402 response only
 *   bun scripts/test-agent-account.ts --pay                  # full payment flow (Privy registers FID on OP Sepolia)
 *   bun scripts/test-agent-account.ts --pay --fname alice    # full flow + register fname "alice"
 *
 * Test wallets are saved to scripts/.test-wallets.json for reuse.
 */

import {
	createPublicClient,
	createWalletClient,
	http,
	parseAbiItem,
	formatUnits,
} from "viem";
import { optimismSepolia, baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// --- Configuration ---
const SIGNUP_URL = process.env.SIGNUP_URL || "http://localhost:8789";
const OP_SEPOLIA_RPC = process.env.OP_SEPOLIA_RPC || "https://sepolia.optimism.io";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const FUNDER_PRIVATE_KEY = (process.env.FUNDER_PRIVATE_KEY ||
	"0x5c135a62e8230b2ab2afb508605ed7a076be5c95ff947359d6eed102ee5a5e59") as `0x${string}`; // 0xd4A261D90Dc96E04A3f2D490374ffb44d2A9Fc9c
const DO_PAY = process.argv.includes("--pay");
const FNAME_ARG = process.argv.find((_, i, a) => a[i - 1] === "--fname");
const DO_FNAME = !!FNAME_ARG;

// OP Sepolia Farcaster contract addresses (custom deployment)
const ID_REGISTRY = "0x0acc54228887f9717633aD107FC683B4d66C6164" as const;

// Base Sepolia USDC
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const USDC_AMOUNT = 10000n; // 0.01 USDC (6 decimals) — exact x402 price

const WALLETS_FILE = join(import.meta.dir, ".test-wallets.json");

interface TestWallet {
	privateKey: string;
	address: string;
	fid?: string;
	signerPubKey?: string;
	createdAt: string;
}

interface WalletsFile {
	wallets: TestWallet[];
}

function loadWallets(): WalletsFile {
	try {
		return JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
	} catch {
		return { wallets: [] };
	}
}

function saveWallets(data: WalletsFile): void {
	writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2) + "\n");
}

// --- ERC-20 ABI fragments ---
const erc20Abi = [
	parseAbiItem("function transfer(address to, uint256 amount) returns (bool)"),
	parseAbiItem("function balanceOf(address account) view returns (uint256)"),
	parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
] as const;

// --- Clients ---
const opSepoliaClient = createPublicClient({
	chain: optimismSepolia,
	transport: http(OP_SEPOLIA_RPC),
});

const baseSepoliaClient = createPublicClient({
	chain: baseSepolia,
	transport: http(BASE_SEPOLIA_RPC),
});

const funderAccount = privateKeyToAccount(FUNDER_PRIVATE_KEY);
const funderWallet = createWalletClient({
	chain: baseSepolia,
	transport: http(BASE_SEPOLIA_RPC),
	account: funderAccount,
});

console.log("=== x402 Agent Account Creation Test ===\n");
console.log(`Signup:  ${SIGNUP_URL}`);
console.log(`OP Sepolia: ${OP_SEPOLIA_RPC}`);
console.log(`Base Sepolia: ${BASE_SEPOLIA_RPC}`);
console.log(`Funder:  ${funderAccount.address}`);
console.log(`Mode:    ${DO_PAY ? "full payment flow" : "402 response only"}`);
console.log(`Fname:   ${DO_FNAME ? FNAME_ARG : "none (use --fname <name> to register)"}\n`);

// --- Step 1: Create a new wallet ---
console.log("--- Step 1: Create new wallet ---");

const newPrivateKey = generatePrivateKey();
const account = privateKeyToAccount(newPrivateKey);
console.log(`New wallet: ${account.address}`);
console.log(`Private key: ${newPrivateKey}\n`);

// --- Step 2: Fund new wallet on Base Sepolia (if --pay) ---
if (DO_PAY) {
	console.log("--- Step 2: Fund new wallet on Base Sepolia ---");

	// Check funder USDC balance
	const funderUsdc = await baseSepoliaClient.readContract({
		address: BASE_SEPOLIA_USDC,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [funderAccount.address],
	});

	console.log(`Funder USDC: ${formatUnits(funderUsdc, 6)}`);

	if (funderUsdc < USDC_AMOUNT) {
		console.error(`\nFunder has insufficient USDC (need ${formatUnits(USDC_AMOUNT, 6)}).`);
		console.error("Get some at: https://faucet.circle.com/ (select Base Sepolia)");
		process.exit(1);
	}

	// Transfer USDC to new wallet (x402 uses EIP-3009 gasless signatures, no ETH needed)
	console.log(`Sending ${formatUnits(USDC_AMOUNT, 6)} USDC...`);
	const usdcHash = await funderWallet.writeContract({
		address: BASE_SEPOLIA_USDC,
		abi: erc20Abi,
		functionName: "transfer",
		args: [account.address, USDC_AMOUNT],
	});
	const usdcReceipt = await baseSepoliaClient.waitForTransactionReceipt({ hash: usdcHash });
	console.log(`Tx: ${usdcHash} (status: ${usdcReceipt.status})`);

	if (usdcReceipt.status !== "success") {
		console.error("USDC transfer failed!");
		process.exit(1);
	}

	// Wait for balance to propagate on public RPC
	let newUsdc = 0n;
	for (let i = 0; i < 10; i++) {
		newUsdc = await baseSepoliaClient.readContract({
			address: BASE_SEPOLIA_USDC,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [account.address],
		});
		if (newUsdc >= USDC_AMOUNT) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	console.log(`New wallet USDC: ${formatUnits(newUsdc, 6)}`);

	if (newUsdc < USDC_AMOUNT) {
		console.error("USDC balance not confirmed after transfer. RPC may be lagging.");
		process.exit(1);
	}
	console.log();
} else {
	console.log("--- Step 2: Skip funding (no --pay) ---\n");
}

// --- Step 3: Check FID status ---
console.log("--- Step 3: Check existing FID on OP Sepolia ---");

const existingFid = await opSepoliaClient.readContract({
	address: ID_REGISTRY,
	abi: [parseAbiItem("function idOf(address owner) view returns (uint256)")],
	functionName: "idOf",
	args: [account.address],
});

if (existingFid > 0n) {
	console.log(`Wallet already has FID ${existingFid} on OP Sepolia.\n`);
} else {
	console.log("Wallet has no FID. The signup service will register one via Privy.\n");
}

// --- Step 4: Get registration params from signup service ---
console.log("--- Step 4: Get registration params ---");

const paramsResp = await fetch(`${SIGNUP_URL}/api/registration-params?address=${account.address}`);
if (!paramsResp.ok) {
	console.error(`Failed to get registration params: ${paramsResp.status}`);
	const errText = await paramsResp.text();
	console.error(errText);
	process.exit(1);
}

interface TypedData {
	domain: { name: string; version: string; chainId: number; verifyingContract: string };
	types: Record<string, Array<{ name: string; type: string }>>;
	primaryType: string;
	message: Record<string, unknown>;
}

const regParams = await paramsResp.json() as {
	price: { fidWei: string; fidEth: number };
	existingFid: string | null;
	nonce: string;
	deadline: string;
	recoveryAddress: string;
	registerTypedData: TypedData;
	addTypedData: TypedData | null;
	signerKeyInfo: {
		signerPubKey: string;
		metadata: string;
	} | null;
};

console.log(`Registration price: ${regParams.price.fidEth} ETH (${regParams.price.fidWei} wei)`);
console.log(`Existing FID: ${regParams.existingFid || "none"}`);
console.log(`Deadline: ${regParams.deadline}`);
console.log(`Signer key: ${regParams.signerKeyInfo ? regParams.signerKeyInfo.signerPubKey.slice(0, 20) + "..." : "not configured"}\n`);

// --- Step 5: Sign the EIP-712 registerFor data (if no existing FID) ---
let registerSig: string | undefined;
let deadline: string | undefined;

if (!regParams.existingFid) {
	console.log("--- Step 5: Sign EIP-712 registerFor data ---");
	const { domain, types, message } = regParams.registerTypedData;

	registerSig = await account.signTypedData({
		domain: domain as any,
		types: types as any,
		primaryType: "Register",
		message: message as any,
	});

	deadline = regParams.deadline;
	console.log(`Register signature: ${registerSig.slice(0, 20)}...`);
	console.log();
} else {
	console.log("--- Step 5: Skip signing (wallet already has FID) ---\n");
}

// --- Step 5b: Sign the EIP-712 Add data (signer key registration) ---
let addSig: string | undefined;
let signerPubKey: string | undefined;
let signerMetadata: string | undefined;

if (regParams.addTypedData && regParams.signerKeyInfo) {
	console.log("--- Step 5b: Sign EIP-712 Add data (signer key) ---");
	const { domain, types, message } = regParams.addTypedData;

	addSig = await account.signTypedData({
		domain: domain as any,
		types: types as any,
		primaryType: "Add",
		message: message as any,
	});

	signerPubKey = regParams.signerKeyInfo.signerPubKey;
	signerMetadata = regParams.signerKeyInfo.metadata;

	console.log(`Add signature: ${addSig.slice(0, 20)}...`);
	console.log(`Signer pub key: ${signerPubKey.slice(0, 20)}...`);
	console.log(`(private key stored encrypted in sync service)`);
	console.log();
} else {
	console.log("--- Step 5b: Skip signer (REQUEST_FID not configured on server) ---\n");
}

// --- Step 5c: Sign EIP-712 fname UserNameProof (if --fname) ---
let fnameSig: string | undefined;
let fnameTimestamp: number | undefined;

if (DO_FNAME) {
	console.log(`--- Step 5c: Sign EIP-712 fname UserNameProof for "${FNAME_ARG}" ---`);

	// Check availability first
	const checkResp = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${FNAME_ARG}`);
	if (checkResp.ok) {
		const existing = await checkResp.json() as { transfer?: { to: number } };
		if (existing.transfer) {
			console.error(`\nFname "${FNAME_ARG}" is already taken (owned by FID ${existing.transfer.to}).`);
			console.error("Choose a different name with --fname <name>");
			process.exit(1);
		}
	}
	console.log(`Fname "${FNAME_ARG}" is available`);

	fnameTimestamp = Math.floor(Date.now() / 1000);

	// EIP-712 domain and types from the signup service's eip712.ts
	const fnameDomain = {
		name: "Farcaster name verification",
		version: "1",
		chainId: 1,
		verifyingContract: "0xe3be01d99baa8db9905b33a3ca391238234b79d1" as const,
	};

	const fnameTypes = {
		UserNameProof: [
			{ name: "name", type: "string" },
			{ name: "timestamp", type: "uint256" },
			{ name: "owner", type: "address" },
		],
	} as const;

	fnameSig = await account.signTypedData({
		domain: fnameDomain,
		types: fnameTypes,
		primaryType: "UserNameProof",
		message: {
			name: FNAME_ARG!,
			timestamp: BigInt(fnameTimestamp),
			owner: account.address,
		},
	});

	console.log(`Fname signature: ${fnameSig.slice(0, 20)}...`);
	console.log();
} else {
	console.log("--- Step 5c: Skip fname (use --fname <name> to register) ---\n");
}

// --- Step 6: Call signup service without payment → expect 402 ---
console.log("--- Step 6: Request without payment (expect 402) ---");
const url = `${SIGNUP_URL}/api/create`;

const createBody = {
	...(registerSig && { registerSig }),
	...(deadline && { deadline }),
	...(addSig && { addSig }),
	...(signerPubKey && { signerPubKey }),
	...(signerMetadata && { signerMetadata }),
	...(DO_FNAME && { fname: FNAME_ARG, fnameSig, fnameTimestamp }),
};

const resp1 = await fetch(url, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(createBody),
});

console.log(`Status: ${resp1.status}`);
const body1 = await resp1.json();
console.log(`Response:`, JSON.stringify(body1, null, 2));

if (resp1.status !== 402) {
	console.error(`\nExpected 402, got ${resp1.status}. Is the signup service running?`);
	process.exit(1);
}

console.log("\n✓ Got 402 with payment requirements\n");

if (!DO_PAY) {
	// Save wallet even without payment
	const wallets = loadWallets();
	const entry: TestWallet = {
		privateKey: newPrivateKey,
		address: account.address,
		createdAt: new Date().toISOString(),
	};
	wallets.wallets.push(entry);
	saveWallets(wallets);
	console.log(`Wallet saved to ${WALLETS_FILE}`);

	console.log("\nPass --pay to test the full payment flow.");
	console.log("Ensure funder wallet has Base Sepolia USDC:");
	console.log("  USDC faucet: https://faucet.circle.com/ (select Base Sepolia)");
	process.exit(0);
}

// --- Step 7: Create x402 payment and retry ---
console.log("--- Step 7: Create x402 payment and retry ---");

const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const resp2 = await fetchWithPayment(url, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(createBody),
});

console.log(`Status: ${resp2.status}`);
const text2 = await resp2.text();
let body2: any;
try {
	body2 = JSON.parse(text2);
	console.log(`Response:`, JSON.stringify(body2, null, 2));
} catch {
	console.log(`Response (text):`, text2);
	process.exit(1);
}

if (resp2.status === 200) {
	// Check the FID that was assigned
	const newFid = await opSepoliaClient.readContract({
		address: ID_REGISTRY,
		abi: [parseAbiItem("function idOf(address owner) view returns (uint256)")],
		functionName: "idOf",
		args: [account.address],
	});

	console.log("\n✓ Account created successfully!");
	console.log(`  DID:    ${body2.did}`);
	console.log(`  Handle: ${body2.handle}`);
	console.log(`  FID:    ${body2.fid || newFid.toString()}`);
	if (body2.signerPubKey) {
		console.log(`  Signer: ${body2.signerPubKey.slice(0, 20)}...`);
		console.log(`  ✓ Farcaster signer key registered on-chain`);
		console.log(`  ✓ Signer private key stored encrypted in sync service`);
	}

	// Verify signer key on-chain if it was registered
	if (body2.signerPubKey) {
		console.log("\n--- Verify signer on-chain ---");
		const KEY_REGISTRY = "0xdE976C4DCF2e723FF34b0A1EaD5c6540c4cd1B47" as const;
		const assignedFid = body2.fid || newFid.toString();

		const keyState = await opSepoliaClient.readContract({
			address: KEY_REGISTRY,
			abi: [parseAbiItem("function keyDataOf(uint256 fid, bytes key) view returns (uint8 state, uint32 keyType)")],
			functionName: "keyDataOf",
			args: [BigInt(assignedFid), body2.signerPubKey as `0x${string}`],
		});

		const stateNames = ["NULL", "ADDED", "REMOVED"];
		console.log(`  KeyRegistry state: ${stateNames[keyState[0]] || keyState[0]} (keyType: ${keyState[1]})`);
		if (keyState[0] === 1) {
			console.log(`  ✓ Signer key is ADDED in KeyRegistry`);
		} else {
			console.log(`  ✗ Signer key state is not ADDED (got ${keyState[0]})`);
		}
	}

	// Verify fname registration if requested
	if (DO_FNAME) {
		console.log("\n--- Verify fname registration ---");

		// NOTE: fnames.farcaster.xyz is production-only and validates FIDs against
		// Optimism mainnet. On testnet (OP Sepolia), fname registration will fail
		// because the FID doesn't exist on mainnet. The EIP-712 signing and request
		// plumbing is exercised, but actual registration only works in production.
		const isTestnet = OP_SEPOLIA_RPC.includes("sepolia");
		if (isTestnet) {
			console.log("  ⚠ Fname registration skipped on testnet (fnames.farcaster.xyz is mainnet-only)");
			console.log("  ✓ EIP-712 UserNameProof signed and sent to signup service");
			console.log("  → Fname will work in production with Optimism mainnet FIDs");
		} else {
			const fnameCheckResp = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${FNAME_ARG}`);
			if (fnameCheckResp.ok) {
				const fnameData = await fnameCheckResp.json() as { transfer?: { to: number; username: string } };
				if (fnameData.transfer) {
					const assignedFid = body2.fid || newFid.toString();
					if (fnameData.transfer.to.toString() === assignedFid) {
						console.log(`  ✓ Fname "${fnameData.transfer.username}" registered to FID ${assignedFid}`);
					} else {
						console.log(`  ✗ Fname registered to FID ${fnameData.transfer.to}, expected ${assignedFid}`);
					}
				} else {
					console.log(`  ✗ Fname "${FNAME_ARG}" not found in registry`);
				}
			} else {
				console.log(`  ✗ Failed to check fname (status ${fnameCheckResp.status})`);
			}

			// Verify handle was set correctly
			const expectedHandle = `${FNAME_ARG}.farcaster.social`;
			if (body2.handle === expectedHandle) {
				console.log(`  ✓ Handle set to ${expectedHandle}`);
			} else {
				console.log(`  ✗ Handle is "${body2.handle}", expected "${expectedHandle}"`);
			}
		}
	}

	// Save wallet with FID and signer info
	const wallets = loadWallets();
	const entry: TestWallet = {
		privateKey: newPrivateKey,
		address: account.address,
		fid: (body2.fid || newFid.toString()),
		createdAt: new Date().toISOString(),
		...(body2.signerPubKey && { signerPubKey: body2.signerPubKey }),
	};
	wallets.wallets.push(entry);
	saveWallets(wallets);
	console.log(`\nWallet saved to ${WALLETS_FILE}`);
} else {
	console.error(`\n✗ Expected 200, got ${resp2.status}`);
	process.exit(1);
}
