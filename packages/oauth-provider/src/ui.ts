/**
 * Authorization consent UI
 * Renders the HTML page for user consent during OAuth authorization
 */

import {
	AccountPermission,
	BlobPermission,
	IdentityPermission,
	IncludeScope,
	RepoPermission,
	RpcPermission,
} from "@atproto/oauth-scopes";
import type { ClientMetadata } from "./storage.js";
import { ATPROTO_SCOPE, ScopesSet } from "./scopes.js";

/**
 * The passkey authentication script (static, can be hashed).
 * Dynamic data is passed via data attributes on the script element.
 */
const PASSKEY_AUTH_SCRIPT = `
// Get dynamic data from script element
const scriptEl = document.currentScript;
const passkeyOptions = JSON.parse(scriptEl.dataset.passkeyOptions);
const oauthParams = JSON.parse(scriptEl.dataset.oauthParams);

// Convert base64url to ArrayBuffer
function base64urlToBuffer(base64url) {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padding = '='.repeat((4 - base64.length % 4) % 4);
	const binary = atob(base64 + padding);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

// Convert ArrayBuffer to base64url
function bufferToBase64url(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary)
		.replace(/\\+/g, '-')
		.replace(/\\//g, '_')
		.replace(/=/g, '');
}

async function authenticateWithPasskey() {
	const btn = document.getElementById('passkey-btn');
	const statusEl = document.querySelector('.passkey-status') || (() => {
		const el = document.createElement('div');
		el.className = 'passkey-status';
		btn.parentNode.insertBefore(el, btn.nextSibling);
		return el;
	})();

	btn.disabled = true;
	btn.innerHTML = '<span class="passkey-icon">🔐</span> Authenticating...';
	statusEl.textContent = '';
	statusEl.className = 'passkey-status';

	try {
		// Convert options for WebAuthn API
		const publicKeyOptions = {
			challenge: base64urlToBuffer(passkeyOptions.challenge),
			timeout: passkeyOptions.timeout,
			rpId: passkeyOptions.rpId,
			userVerification: passkeyOptions.userVerification,
			allowCredentials: (passkeyOptions.allowCredentials || []).map(cred => ({
				id: base64urlToBuffer(cred.id),
				type: cred.type,
				transports: cred.transports,
			})),
		};

		// Perform WebAuthn ceremony
		// mediation: "optional" ensures modal UI appears for cross-device auth
		const credential = await navigator.credentials.get({
			publicKey: publicKeyOptions,
			mediation: "optional"
		});

		if (!credential) {
			throw new Error('No credential returned');
		}

		// Prepare response for server
		const response = {
			id: credential.id,
			rawId: bufferToBase64url(credential.rawId),
			response: {
				clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
				authenticatorData: bufferToBase64url(credential.response.authenticatorData),
				signature: bufferToBase64url(credential.response.signature),
				userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : undefined,
			},
			type: credential.type,
			clientExtensionResults: credential.getClientExtensionResults(),
			authenticatorAttachment: credential.authenticatorAttachment,
		};

		// Submit to server
		const result = await fetch('/oauth/passkey-auth', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				response,
				challenge: passkeyOptions.challenge,
				oauthParams,
			}),
		});

		const data = await result.json();

		if (data.redirectUrl) {
			// Success - redirect to complete authorization
			window.location.href = data.redirectUrl;
		} else {
			throw new Error(data.error || 'Authentication failed');
		}
	} catch (err) {
		console.error('Passkey auth error:', err);
		statusEl.textContent = err.name === 'NotAllowedError' ? 'Authentication cancelled' : (err.message || 'Authentication failed');
		statusEl.className = 'passkey-status error';
		btn.disabled = false;
		btn.innerHTML = '<span class="passkey-icon">🔐</span> Sign in with Passkey';
	}
}

const passkeyBtn = document.getElementById('passkey-btn');
if (passkeyBtn) {
	passkeyBtn.addEventListener('click', authenticateWithPasskey);
}
`;

/**
 * Compute SHA-256 hash for CSP script-src
 */
async function computeScriptHash(script: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(script);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const base64Hash = btoa(String.fromCharCode(...hashArray));
	return `'sha256-${base64Hash}'`;
}

// Pre-computed hash (computed at module load, will be a Promise)
let passkeyAuthScriptHashPromise: Promise<string> | null = null;

/**
 * Get the script hash for the passkey auth script
 */
export async function getPasskeyAuthScriptHash(): Promise<string> {
	if (!passkeyAuthScriptHashPromise) {
		passkeyAuthScriptHashPromise = computeScriptHash(PASSKEY_AUTH_SCRIPT);
	}
	return passkeyAuthScriptHashPromise;
}

/**
 * Content Security Policy for the consent UI
 *
 * - default-src 'none': Deny all by default
 * - style-src 'unsafe-inline': Allow inline styles (our CSS is inline)
 * - img-src https: data:: Allow images from HTTPS URLs (client logos) and data URIs
 * - frame-ancestors 'none': Prevent clickjacking by disallowing framing
 * - base-uri 'none': Prevent base tag injection
 *
 * Note: form-action is intentionally omitted. Browser behavior for blocking
 * redirects after form submission is inconsistent - Chrome blocks redirects
 * to URLs not in form-action, while Firefox does not. Since OAuth requires
 * redirecting to the client's callback URL after form submission, we cannot
 * use form-action without breaking the flow in Chrome.
 * See: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action
 */
export async function getConsentUiCsp(
	includePasskeyScript: boolean,
): Promise<string> {
	const scriptSrc = includePasskeyScript
		? await getPasskeyAuthScriptHash()
		: "'none'";
	return `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Metadata about a permission-set bundle the client requested via an
 * `include:` scope. Used to render a friendly bundle title in the consent UI
 * instead of the bare NSID.
 */
export interface PermissionSetBundle {
	/** The bundle's NSID (matches an `include:NSID?aud=...` scope token). */
	nsid: string;
	/** Human-readable title from the lexicon document, if any. */
	title?: string;
	/** Longer human-readable detail from the lexicon document, if any. */
	detail?: string;
	/**
	 * Set when resolution failed. The consent UI surfaces this as a warning
	 * and disables the Allow button — granting permissions you couldn't see
	 * is a security footgun.
	 */
	error?: string;
}

/**
 * A consent-UI permission line. Either a single string or a "summary +
 * collapsible items" pair. The latter renders as a `<details>` disclosure so
 * apps requesting many granular scopes (e.g. tangled.org with 21 `repo:` and
 * 13 `rpc:` scopes) collapse into a few audit-friendly lines instead of a
 * 30-line wall of text.
 */
export type ScopeDescription = string | { summary: string; items: string[] };

/** Collapse a group into a `<details>` only when there are this many or more. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Longest common dot-separated prefix of a list of NSIDs, ending at a
 * segment boundary. Returns null when no useful (≥2-segment) prefix exists.
 */
function commonNsidPrefix(nsids: readonly string[]): string | null {
	if (nsids.length === 0) return null;
	const segmented = nsids.map((n) => n.split("."));
	const minLen = Math.min(...segmented.map((s) => s.length));
	const shared: string[] = [];
	for (let i = 0; i < minLen; i++) {
		const seg = segmented[0]![i]!;
		if (segmented.every((s) => s[i] === seg)) {
			shared.push(seg);
		} else break;
	}
	if (shared.length < 2) return null;
	return shared.join(".");
}

/**
 * Parse scope string into human-readable descriptions.
 *
 * Recognizes the legacy `atproto` / `transition:*` scopes and the granular
 * resource scopes from the atproto permissions spec (`repo:`, `rpc:`, `blob:`,
 * `account:`, `identity:`, `include:`).
 *
 * Long flat lists are collapsed by NSID authority — e.g. 21 `repo:sh.tangled.*`
 * scopes become one "Write records under sh.tangled.* (21 record types)" line
 * with the full list available behind a disclosure.
 *
 * `bundles`, when supplied, lets us render `include:` scopes as the bundle's
 * human title rather than just its NSID.
 */
function getScopeDescriptions(
	scope: string,
	bundles?: readonly PermissionSetBundle[],
): ScopeDescription[] {
	const set = ScopesSet.fromString(scope);
	const out: ScopeDescription[] = [];

	if (set.has(ATPROTO_SCOPE)) {
		out.push("Access your AT Protocol account");
	}
	if (set.has("transition:generic")) {
		out.push("Perform account operations");
	}
	if (set.has("transition:email")) {
		out.push("Read your account email");
	}
	if (set.has("transition:chat.bsky")) {
		out.push("Access chat functionality");
	}

	// Bucket granular scopes by resource type so we can group within each.
	const repos: RepoPermission[] = [];
	const rpcs: RpcPermission[] = [];
	const blobs: BlobPermission[] = [];
	const accounts: AccountPermission[] = [];
	const identities: IdentityPermission[] = [];
	const includes: IncludeScope[] = [];

	for (const s of set) {
		const colon = s.indexOf(":");
		if (colon === -1) continue;
		const resource = s.slice(0, colon);
		if (resource === "repo") {
			const p = RepoPermission.fromString(s);
			if (p) repos.push(p);
		} else if (resource === "rpc") {
			const p = RpcPermission.fromString(s);
			if (p) rpcs.push(p);
		} else if (resource === "blob") {
			const p = BlobPermission.fromString(s);
			if (p) blobs.push(p);
		} else if (resource === "account") {
			const p = AccountPermission.fromString(s);
			if (p) accounts.push(p);
		} else if (resource === "identity") {
			const p = IdentityPermission.fromString(s);
			if (p) identities.push(p);
		} else if (resource === "include") {
			const p = IncludeScope.fromString(s);
			if (p) includes.push(p);
		}
	}

	// repo: collapse default-action scopes that share an NSID authority.
	const fullActions = ["create", "update", "delete"] as const;
	const isDefaultActions = (p: RepoPermission) =>
		p.action.length === 3 &&
		fullActions.every((a) => p.action.includes(a));

	const repoFull: RepoPermission[] = [];
	const repoOther: RepoPermission[] = [];
	for (const p of repos) {
		if (isDefaultActions(p)) repoFull.push(p);
		else repoOther.push(p);
	}

	// Each repo permission can carry multiple collections — flatten to NSIDs.
	const repoFullNsids = repoFull
		.flatMap((p) => p.collection)
		.filter((c) => c !== "*");
	const repoHasWildcard = repoFull.some((p) => p.collection.includes("*"));

	if (repoHasWildcard) {
		out.push("Write any record in your repository");
	} else if (repoFullNsids.length >= COLLAPSE_THRESHOLD) {
		const prefix = commonNsidPrefix(repoFullNsids);
		const items = repoFullNsids.slice().sort();
		if (prefix) {
			out.push({
				summary: `Write records under ${prefix}.* in your repository (${repoFullNsids.length} record types)`,
				items,
			});
		} else {
			out.push({
				summary: `Write records in your repository (${repoFullNsids.length} record types)`,
				items,
			});
		}
	} else {
		for (const nsid of repoFullNsids) {
			out.push(`Write records (create, update, delete) for ${nsid}`);
		}
	}
	for (const p of repoOther) {
		const collections = p.collection.includes("*")
			? "any record type"
			: p.collection.join(", ");
		out.push(`${p.action.join(", ")} records for ${collections}`);
	}

	// rpc: collapse when ≥3 share the same `aud` (the most user-meaningful axis).
	const rpcByAud = new Map<string, RpcPermission[]>();
	for (const p of rpcs) {
		const k = p.aud as string;
		const arr = rpcByAud.get(k) ?? [];
		arr.push(p);
		rpcByAud.set(k, arr);
	}
	for (const [aud, group] of rpcByAud) {
		const lxms = group.flatMap((p) => p.lxm).filter((l) => l !== "*");
		const wildcard = group.some((p) => p.lxm.includes("*"));
		const audLabel = aud === "*" ? "any service" : aud;
		if (wildcard) {
			out.push(`Call any API method on ${audLabel}`);
		} else if (lxms.length >= COLLAPSE_THRESHOLD) {
			const prefix = commonNsidPrefix(lxms);
			const items = lxms.slice().sort();
			out.push({
				summary: prefix
					? `Call ${lxms.length} ${prefix}.* API methods on ${audLabel}`
					: `Call ${lxms.length} API methods on ${audLabel}`,
				items,
			});
		} else {
			for (const lxm of lxms) {
				out.push(`Call ${lxm} on ${audLabel}`);
			}
		}
	}

	for (const p of blobs) {
		const types = p.accept.includes("*/*")
			? "any type"
			: p.accept.join(", ");
		out.push(`Upload media (${types})`);
	}
	for (const p of accounts) {
		const verb = p.action.includes("manage") ? "Read and manage" : "Read";
		out.push(`${verb} your account ${p.attr}`);
	}
	for (const p of identities) {
		out.push(`Manage your ${p.attr === "*" ? "identity" : p.attr}`);
	}
	for (const inc of includes) {
		const bundle = bundles?.find((b) => b.nsid === inc.nsid);
		if (bundle?.error) {
			out.push(
				`⚠️ ${inc.nsid} — could not resolve permission set: ${bundle.error}`,
			);
		} else if (bundle?.title) {
			out.push(
				bundle.detail ? `${bundle.title} — ${bundle.detail}` : bundle.title,
			);
		} else {
			out.push(`Permissions from ${inc.nsid}`);
		}
	}

	if (out.length === 0) {
		out.push("Access your account on your behalf");
	}

	return out;
}

/**
 * Options for rendering the consent UI
 */
export interface ConsentUIOptions {
	/** The OAuth client metadata */
	client: ClientMetadata;
	/** The requested scope */
	scope: string;
	/** URL to POST the consent form to */
	authorizeUrl: string;
	/** State parameter to include in the form */
	state: string;
	/** OAuth parameters to include as hidden fields */
	oauthParams: Record<string, string>;
	/** User's handle (for display) */
	userHandle?: string;
	/** Whether to show a login form instead of consent */
	showLogin?: boolean;
	/** Error message to display */
	error?: string;
	/** Whether passkey login is available */
	passkeyAvailable?: boolean;
	/** WebAuthn authentication options for passkey login */
	passkeyOptions?: Record<string, unknown>;
	/**
	 * Resolved metadata for any permission-set `include:` scopes in the
	 * request. The consent UI uses this to show the bundle's title/detail
	 * instead of the bare NSID.
	 */
	bundles?: readonly PermissionSetBundle[];
}

/**
 * Render the consent UI HTML
 * @param options Consent UI options
 * @returns HTML string
 */
export function renderConsentUI(options: ConsentUIOptions): string {
	const {
		client,
		scope,
		authorizeUrl,
		oauthParams,
		userHandle,
		showLogin,
		error,
		passkeyAvailable,
		passkeyOptions,
	} = options;

	const clientName = escapeHtml(client.clientName);
	const scopeDescriptions = getScopeDescriptions(scope, options.bundles);
	const hasResolutionFailure = !!options.bundles?.some((b) => b.error);
	const logoHtml = client.logoUri
		? `<img src="${escapeHtml(client.logoUri)}" alt="${clientName} logo" class="app-logo" />`
		: `<div class="app-logo-placeholder">${clientName.charAt(0).toUpperCase()}</div>`;

	const errorHtml = error
		? `<div class="error-message">${escapeHtml(error)}</div>`
		: "";

	const loginFormHtml = showLogin
		? `
			<div class="login-form">
				<p>Sign in to continue</p>
				${
					passkeyAvailable
						? `
				<button type="button" class="btn-passkey" id="passkey-btn">
					<span class="passkey-icon">🔐</span>
					Sign in with Passkey
				</button>
				<div class="or-divider"><span>or</span></div>
				`
						: ""
				}
				<input type="password" name="password" placeholder="Password" autocomplete="current-password" required />
			</div>
		`
		: "";

	// Render OAuth params as hidden form fields
	const hiddenFieldsHtml = Object.entries(oauthParams)
		.map(
			([key, value]) =>
				`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`,
		)
		.join("\n\t\t\t");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Authorize ${clientName}</title>
	<style>
		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
			color: #e0e0e0;
		}

		.container {
			background: #1e1e30;
			border-radius: 16px;
			padding: 32px;
			max-width: 400px;
			width: 100%;
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
			border: 1px solid rgba(255, 255, 255, 0.1);
		}

		.header {
			text-align: center;
			margin-bottom: 24px;
		}

		.app-logo {
			width: 64px;
			height: 64px;
			border-radius: 12px;
			margin-bottom: 16px;
			object-fit: cover;
		}

		.app-logo-placeholder {
			width: 64px;
			height: 64px;
			border-radius: 12px;
			margin: 0 auto 16px;
			background: linear-gradient(135deg, #3b82f6, #8b5cf6);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 28px;
			font-weight: 600;
			color: white;
		}

		h1 {
			font-size: 20px;
			font-weight: 600;
			margin-bottom: 8px;
		}

		.client-name {
			color: #60a5fa;
		}

		.user-info {
			font-size: 14px;
			color: #9ca3af;
		}

		.permissions {
			background: rgba(255, 255, 255, 0.05);
			border-radius: 12px;
			padding: 16px;
			margin-bottom: 24px;
		}

		.permissions-title {
			font-size: 14px;
			color: #9ca3af;
			margin-bottom: 12px;
		}

		.permissions-list {
			list-style: none;
		}

		.permissions-list li {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 8px 0;
			font-size: 14px;
		}

		.permissions-list li::before {
			content: "";
			width: 8px;
			height: 8px;
			background: #22c55e;
			border-radius: 50%;
			flex-shrink: 0;
		}

		.permissions-list li.has-details {
			align-items: flex-start;
		}

		.permissions-list li.has-details details {
			flex: 1;
			min-width: 0;
		}

		.permissions-list li.has-details summary {
			cursor: pointer;
			list-style: none;
		}

		.permissions-list li.has-details summary::-webkit-details-marker {
			display: none;
		}

		.permissions-list li.has-details summary::after {
			content: " ▸";
			color: #6b7280;
			font-size: 12px;
		}

		.permissions-list li.has-details details[open] summary::after {
			content: " ▾";
		}

		.permissions-list li.has-details ul {
			list-style: none;
			margin-top: 8px;
			padding-left: 0;
			border-left: 2px solid rgba(255, 255, 255, 0.08);
		}

		.permissions-list li.has-details ul li {
			padding: 4px 0 4px 12px;
			font-size: 13px;
			color: #9ca3af;
		}

		.permissions-list li.has-details ul li::before {
			display: none;
		}

		.buttons {
			display: flex;
			gap: 12px;
		}

		button {
			flex: 1;
			padding: 12px 20px;
			border-radius: 8px;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.2s;
			border: none;
		}

		.btn-deny {
			background: rgba(255, 255, 255, 0.1);
			color: #e0e0e0;
		}

		.btn-deny:hover {
			background: rgba(255, 255, 255, 0.15);
		}

		.btn-allow {
			background: linear-gradient(135deg, #3b82f6, #2563eb);
			color: white;
		}

		.btn-allow:hover {
			background: linear-gradient(135deg, #2563eb, #1d4ed8);
		}

		.btn-allow:disabled {
			background: rgba(255, 255, 255, 0.08);
			color: #6b7280;
			cursor: not-allowed;
		}

		.permissions-warning {
			margin: 12px 0 0;
			padding: 10px 12px;
			border-radius: 8px;
			background: rgba(239, 68, 68, 0.12);
			border: 1px solid rgba(239, 68, 68, 0.3);
			color: #fca5a5;
			font-size: 13px;
		}

		.info {
			margin-top: 16px;
			font-size: 12px;
			color: #6b7280;
			text-align: center;
		}

		.error-message {
			background: rgba(239, 68, 68, 0.1);
			border: 1px solid rgba(239, 68, 68, 0.3);
			color: #f87171;
			padding: 12px;
			border-radius: 8px;
			margin-bottom: 16px;
			font-size: 14px;
			text-align: center;
		}

		.login-form {
			margin-bottom: 24px;
		}

		.login-form p {
			font-size: 14px;
			color: #9ca3af;
			margin-bottom: 12px;
		}

		.login-form input {
			width: 100%;
			padding: 12px;
			border-radius: 8px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.05);
			color: #e0e0e0;
			font-size: 14px;
		}

		.login-form input:focus {
			outline: none;
			border-color: #3b82f6;
		}

		.login-form input::placeholder {
			color: #6b7280;
		}

		.client-uri {
			font-size: 12px;
			color: #6b7280;
			margin-top: 4px;
		}

		.client-uri a {
			color: #60a5fa;
			text-decoration: none;
		}

		.client-uri a:hover {
			text-decoration: underline;
		}

		.btn-passkey {
			width: 100%;
			padding: 12px 20px;
			border-radius: 8px;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.2s;
			border: 1px solid rgba(255, 255, 255, 0.2);
			background: rgba(255, 255, 255, 0.05);
			color: #e0e0e0;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 8px;
		}

		.btn-passkey:hover:not(:disabled) {
			background: rgba(255, 255, 255, 0.1);
			border-color: #3b82f6;
		}

		.btn-passkey:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.passkey-icon {
			font-size: 16px;
		}

		.or-divider {
			display: flex;
			align-items: center;
			margin: 16px 0;
			color: #6b7280;
			font-size: 12px;
		}

		.or-divider::before,
		.or-divider::after {
			content: "";
			flex: 1;
			height: 1px;
			background: rgba(255, 255, 255, 0.1);
		}

		.or-divider span {
			padding: 0 12px;
		}

		.passkey-status {
			margin-top: 8px;
			font-size: 12px;
			text-align: center;
			min-height: 16px;
		}

		.passkey-status.error {
			color: #f87171;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			${logoHtml}
			<h1>Authorize <span class="client-name">${clientName}</span></h1>
			${userHandle ? `<p class="user-info">as @${escapeHtml(userHandle)}</p>` : ""}
			${client.clientUri ? `<p class="client-uri"><a href="${escapeHtml(client.clientUri)}" target="_blank" rel="noopener">${escapeHtml(new URL(client.clientUri).hostname)}</a></p>` : ""}
		</div>

		${errorHtml}

		<form method="POST" action="${escapeHtml(authorizeUrl)}">
			${hiddenFieldsHtml}

			${loginFormHtml}

			<div class="permissions">
				<p class="permissions-title">This app wants to:</p>
				<ul class="permissions-list">
					${scopeDescriptions
						.map((desc) =>
							typeof desc === "string"
								? `<li>${escapeHtml(desc)}</li>`
								: `<li class="has-details"><details><summary>${escapeHtml(desc.summary)}</summary><ul>${desc.items
										.map((i) => `<li>${escapeHtml(i)}</li>`)
										.join("")}</ul></details></li>`,
						)
						.join("")}
				</ul>
				${
					hasResolutionFailure
						? `<p class="permissions-warning">One or more permission sets could not be resolved. You can't safely grant permissions you can't see.</p>`
						: ""
				}
			</div>

			<div class="buttons">
				<button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
				<button type="submit" name="action" value="allow" class="btn-allow"${hasResolutionFailure ? " disabled" : ""}>Allow</button>
			</div>
		</form>

		<p class="info">You can revoke access anytime in your account settings.</p>
	</div>
	${
		passkeyAvailable && passkeyOptions
			? `
	<script data-passkey-options="${escapeHtml(JSON.stringify(passkeyOptions))}" data-oauth-params="${escapeHtml(JSON.stringify(oauthParams))}">${PASSKEY_AUTH_SCRIPT}</script>
	`
			: ""
	}
</body>
</html>`;
}

/**
 * Render an error page
 * @param error Error code
 * @param description Error description
 * @param redirectUri Optional redirect URI for the error
 * @returns HTML string
 */
export function renderErrorPage(
	error: string,
	description: string,
	redirectUri?: string,
): string {
	const escapedError = escapeHtml(error);
	const escapedDescription = escapeHtml(description);

	const redirectHtml = redirectUri
		? `<p style="margin-top: 16px;"><a href="${escapeHtml(redirectUri)}" style="color: #60a5fa;">Return to application</a></p>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Authorization Error</title>
	<style>
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
			color: #e0e0e0;
			margin: 0;
		}

		.container {
			background: #1e1e30;
			border-radius: 16px;
			padding: 32px;
			max-width: 400px;
			width: 100%;
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
			border: 1px solid rgba(255, 255, 255, 0.1);
			text-align: center;
		}

		.error-icon {
			width: 64px;
			height: 64px;
			background: rgba(239, 68, 68, 0.1);
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 auto 16px;
			font-size: 32px;
		}

		h1 {
			font-size: 20px;
			margin-bottom: 8px;
			color: #f87171;
		}

		p {
			color: #9ca3af;
			font-size: 14px;
		}

		code {
			background: rgba(255, 255, 255, 0.1);
			padding: 2px 6px;
			border-radius: 4px;
			font-size: 12px;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="error-icon">!</div>
		<h1>Authorization Error</h1>
		<p>${escapedDescription}</p>
		<p style="margin-top: 8px;"><code>${escapedError}</code></p>
		${redirectHtml}
	</div>
</body>
</html>`;
}
