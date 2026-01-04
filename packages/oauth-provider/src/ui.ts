/**
 * Authorization consent UI
 * Renders the HTML page for user consent during OAuth authorization
 */

import type { ClientMetadata } from "./storage.js";

/**
 * Generate Content Security Policy for the consent UI
 *
 * - default-src 'none': Deny all by default
 * - style-src 'unsafe-inline': Allow inline styles (our CSS is inline)
 * - img-src https: data:: Allow images from HTTPS URLs (client logos) and data URIs
 * - form-action 'self' <issuer>: Form can only POST to same origin (explicit issuer for browser compatibility)
 * - frame-ancestors 'none': Prevent clickjacking by disallowing framing
 * - base-uri 'none': Prevent base tag injection
 *
 * @param issuer The OAuth issuer URL to explicitly allow in form-action
 */
export function getConsentUICSP(issuer: string): string {
	return `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self' ${issuer}; frame-ancestors 'none'; base-uri 'none'`;
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
}

/**
 * Render the consent UI HTML
 * @param options Consent UI options
 * @returns HTML string
 */
export function renderConsentUI(options: ConsentUIOptions): string {
	const { client, scope, authorizeUrl, oauthParams, userHandle, showLogin, error } = options;

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
				<input type="password" name="password" placeholder="Password" required autocomplete="current-password" />
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
