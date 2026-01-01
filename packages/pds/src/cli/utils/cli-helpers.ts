/**
 * Shared CLI utilities for PDS commands
 */
import * as p from "@clack/prompts";
import type { TextOptions, ConfirmOptions, SelectOptions } from "@clack/prompts";

/**
 * Prompt for text input, exiting on cancel
 */
export async function promptText(options: TextOptions): Promise<string> {
	const result = await p.text(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result as string;
}

/**
 * Prompt for confirmation, exiting on cancel
 */
export async function promptConfirm(options: ConfirmOptions): Promise<boolean> {
	const result = await p.confirm(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result;
}

/**
 * Prompt for selection, exiting on cancel
 */
export async function promptSelect<V>(options: SelectOptions<V>): Promise<V> {
	const result = await p.select(options);
	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result as V;
}

/**
 * Get target PDS URL based on mode
 */
export function getTargetUrl(
	isDev: boolean,
	pdsHostname: string | undefined,
): string {
	if (isDev) {
		return `http://localhost:${process.env.PORT ? (parseInt(process.env.PORT) ?? "5173") : "5173"}`;
	}
	if (!pdsHostname) {
		throw new Error("PDS_HOSTNAME not configured in wrangler.jsonc");
	}
	return `https://${pdsHostname}`;
}

/**
 * Extract domain from URL
 */
export function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
