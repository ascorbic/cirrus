/**
 * Generate signing keys for the Edge PDS
 * Run with: npx tsx scripts/generate-keys.ts
 */

import { Secp256k1Keypair } from "@atproto/crypto"

async function main() {
	// Generate a new secp256k1 keypair
	const keypair = await Secp256k1Keypair.create({ exportable: true })

	// Export the private key as hex
	const privateKeyBytes = await keypair.export()
	const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex")

	// Get the public key in did:key format
	const did = keypair.did()

	// Get the public key multibase from did:key (includes multicodec prefix)
	// This is the correct format for DID document verificationMethod
	const publicKeyMultibase = did.replace("did:key:", "")

	console.log("=== Edge PDS Signing Keys ===\n")
	console.log("Set these secrets with wrangler:\n")
	console.log(`npx wrangler secret put SIGNING_KEY`)
	console.log(`# Paste: ${privateKeyHex}\n`)
	console.log(`npx wrangler secret put SIGNING_KEY_PUBLIC`)
	console.log(`# Paste: ${publicKeyMultibase}\n`)
	console.log("=== DID Information ===\n")
	console.log(`did:key format: ${did}`)
	console.log(`\nFor did:web:pds.mk.gg, you'll need to serve a DID document at:`)
	console.log(`https://pds.mk.gg/.well-known/did.json`)
	console.log(`\nExample DID document:`)
	console.log(
		JSON.stringify(
			{
				"@context": [
					"https://www.w3.org/ns/did/v1",
					"https://w3id.org/security/multikey/v1",
					"https://w3id.org/security/suites/secp256k1-2019/v1",
				],
				id: "did:web:pds.mk.gg",
				verificationMethod: [
					{
						id: "did:web:pds.mk.gg#atproto",
						type: "Multikey",
						controller: "did:web:pds.mk.gg",
						publicKeyMultibase: publicKeyMultibase,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.mk.gg",
					},
				],
			},
			null,
			2
		)
	)
}

main().catch(console.error)
