import { AtpAgent } from "@atproto/api";
import { now as tidNow } from "@atcute/tid";

export function getPort(): number {
	return (
		((globalThis as Record<string, unknown>).__e2e_port__ as number) ?? 5173
	);
}

export function getBaseUrl(): string {
	return `http://localhost:${getPort()}`;
}

export function createAgent(): AtpAgent {
	return new AtpAgent({ service: getBaseUrl() });
}

/**
 * Generate a unique TID-format rkey for test isolation. Most app.bsky.*
 * record collections constrain the rkey to TID format, so tests can't use
 * arbitrary strings.
 */
export function uniqueRkey(): string {
	return tidNow();
}

export const TEST_DID = "did:web:test.local";
export const TEST_HANDLE = "test.local";
export const TEST_PASSWORD = "test-password"; // Matches PASSWORD_HASH in .dev.vars
