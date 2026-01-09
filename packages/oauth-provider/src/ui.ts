/**
 * Authorization consent UI
 * Renders the HTML page for user consent during OAuth authorization
 */

import type { ClientMetadata } from "./storage.js";

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
export async function getConsentUiCsp(includePasskeyScript: boolean): Promise<string> {
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
 * Parse scope string into human-readable descriptions
 */
function getScopeDescriptions(scope: string): string[] {
	const scopes = scope.split(" ").filter(Boolean);
	const descriptions: string[] = [];

	for (const s of scopes) {
		switch (s) {
			case "atproto":
				descriptions.push("Access your AT Protocol account");
				break;
			case "transition:generic":
				descriptions.push("Perform account operations");
				break;
			case "transition:chat.bsky":
				descriptions.push("Access chat functionality");
				break;
			default:
				// Don't show unknown scopes to avoid confusion
				break;
		}
	}

	// If no recognized scopes, show a generic message
	if (descriptions.length === 0) {
		descriptions.push("Access your account on your behalf");
	}

	return descriptions;
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
}

/**
 * Render the consent UI HTML
 * @param options Consent UI options
 * @returns HTML string
 */
export function renderConsentUI(options: ConsentUIOptions): string {
	const { client, scope, authorizeUrl, oauthParams, userHandle, showLogin, error, passkeyAvailable, passkeyOptions } = options;

	const clientName = escapeHtml(client.clientName);
	const scopeDescriptions = getScopeDescriptions(scope);
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
				${passkeyAvailable ? `
				<button type="button" class="btn-passkey" id="passkey-btn">
					<span class="passkey-icon">🔐</span>
					Sign in with Passkey
				</button>
				<div class="or-divider"><span>or</span></div>
				` : ""}
				<input type="password" name="password" placeholder="Password" autocomplete="current-password" required />
			</div>
		`
		: "";

	// Render OAuth params as hidden form fields
	const hiddenFieldsHtml = Object.entries(oauthParams)
		.map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
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
					${scopeDescriptions.map((desc) => `<li>${escapeHtml(desc)}</li>`).join("")}
				</ul>
			</div>

			<div class="buttons">
				<button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
				<button type="submit" name="action" value="allow" class="btn-allow">Allow</button>
			</div>
		</form>

		<p class="info">You can revoke access anytime in your account settings.</p>
	</div>
	${passkeyAvailable && passkeyOptions ? `
	<script data-passkey-options="${escapeHtml(JSON.stringify(passkeyOptions))}" data-oauth-params="${escapeHtml(JSON.stringify(oauthParams))}">${PASSKEY_AUTH_SCRIPT}</script>
	` : ""}
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
	redirectUri?: string
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
