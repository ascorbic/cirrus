/**
 * x402 Payment Middleware for Agent Account Creation
 *
 * Custom x402 flow that verifies payment and extracts the payer address.
 * We don't use the standard @x402/hono middleware because it doesn't
 * expose the payer address to route handlers — which we need to verify
 * FID ownership (payer must be the FID's custody address).
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "./types";

/** Default USDC config per network (x402 SDK network names) */
const USDC_DEFAULTS: Record<string, { address: string; name: string; version: string }> = {
	base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
	"base-sepolia": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
};

/** Payment requirements returned in 402 response (x402 v1 format) */
interface PaymentRequirements {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	mimeType: string;
	outputSchema: Record<string, unknown>;
	maxTimeoutSeconds: number;
	asset: string;
	payTo: string;
	extra: Record<string, unknown>;
}

/** Facilitator verify response */
interface VerifyResponse {
	isValid: boolean;
	invalidReason?: string;
	invalidMessage?: string;
	payer?: string;
}

/**
 * Build payment requirements from env vars.
 */
function buildRequirements(
	env: { X402_PRICE: string; X402_PAY_TO: string; X402_NETWORK?: string; X402_ASSET?: string },
	resourceUrl: string,
): PaymentRequirements {
	const network = env.X402_NETWORK || "base";
	const defaults = USDC_DEFAULTS[network] || USDC_DEFAULTS["base"]!;
	const asset = env.X402_ASSET || defaults.address;

	return {
		scheme: "exact",
		network,
		maxAmountRequired: env.X402_PRICE,
		resource: resourceUrl,
		description: "Create a fid.is AT Protocol account for an AI agent",
		mimeType: "application/json",
		outputSchema: {},
		maxTimeoutSeconds: 60,
		asset,
		payTo: env.X402_PAY_TO,
		extra: {
			name: defaults.name,
			version: defaults.version,
		},
	};
}

/**
 * Creates x402 middleware that gates a route behind payment and extracts the payer address.
 *
 * When payment is verified, the payer address is stored in the context
 * via `c.set("x402Payer", address)`.
 */
export function x402PaymentMiddleware() {
	return async (c: Context<AppEnv>, next: Next) => {
		const env = c.env;

		if (!env.X402_FACILITATOR_URL || !env.X402_PRICE || !env.X402_PAY_TO) {
			return c.json(
				{ error: "ServerError", message: "x402 payment not configured" },
				500,
			);
		}

		const paymentHeader =
			c.req.header("x-payment") || c.req.header("payment-signature");

		if (!paymentHeader) {
			// No payment — return 402 with payment requirements (x402 v1 format).
			const requirements = buildRequirements(env, c.req.url);
			return c.json(
				{
					x402Version: 1,
					accepts: [requirements],
				},
				402,
			);
		}

		// Payment header present — verify with facilitator
		let paymentPayload: unknown;
		try {
			paymentPayload = JSON.parse(atob(paymentHeader));
		} catch {
			return c.json(
				{ error: "InvalidPayment", message: "Malformed payment header" },
				400,
			);
		}

		const requirements = buildRequirements(env, c.req.url);

		let verifyResult: VerifyResponse;
		try {
			const resp = await fetch(
				`${env.X402_FACILITATOR_URL}/verify`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						x402Version: 1,
						paymentPayload,
						paymentRequirements: requirements,
					}),
				},
			);

			if (!resp.ok) {
				return c.json(
					{ error: "PaymentVerificationFailed", message: "Facilitator rejected payment" },
					402,
				);
			}

			verifyResult = (await resp.json()) as VerifyResponse;
		} catch {
			return c.json(
				{ error: "ServerError", message: "Failed to verify payment with facilitator" },
				502,
			);
		}

		if (!verifyResult.isValid) {
			return c.json(
				{
					error: "PaymentInvalid",
					message: verifyResult.invalidMessage || verifyResult.invalidReason || "Payment verification failed",
				},
				402,
			);
		}

		if (!verifyResult.payer) {
			return c.json(
				{ error: "PaymentInvalid", message: "No payer address in payment verification" },
				402,
			);
		}

		// Store payer address for the route handler
		c.set("x402Payer" as never, verifyResult.payer as never);

		// Run the route handler
		await next();

		// Settle the payment after successful response
		if (c.res.ok) {
			try {
				await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						x402Version: 1,
						paymentPayload,
						paymentRequirements: requirements,
					}),
				});
			} catch {
				// Settlement failure is logged but doesn't fail the response
				console.error("x402 settlement failed");
			}
		}
	};
}
