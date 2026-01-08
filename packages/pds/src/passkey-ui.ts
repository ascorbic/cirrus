/**
 * Passkey Registration UI
 *
 * Renders the HTML page for passkey registration.
 * Matches the styling of the OAuth consent UI.
 */

import type { PublicKeyCredentialCreationOptionsJSON } from "./passkey";

/**
 * The main registration script (static, can be hashed).
 * Dynamic data is passed via data attributes on the script element.
 */
const PASSKEY_REGISTRATION_SCRIPT = `
// Get dynamic data from script element
const scriptEl = document.currentScript;
const options = JSON.parse(scriptEl.dataset.options);
const token = scriptEl.dataset.token;

// Convert base64url challenge to ArrayBuffer
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

async function registerPasskey() {
	const btn = document.getElementById('register-btn');
	const status = document.getElementById('status');

	btn.disabled = true;
	btn.textContent = 'Registering...';
	status.textContent = '';
	status.className = 'status';

	try {
		// Convert options for WebAuthn API
		const publicKeyOptions = {
			challenge: base64urlToBuffer(options.challenge),
			rp: options.rp,
			user: {
				id: base64urlToBuffer(options.user.id),
				name: options.user.name,
				displayName: options.user.displayName,
			},
			pubKeyCredParams: options.pubKeyCredParams,
			timeout: options.timeout,
			attestation: options.attestation,
			authenticatorSelection: options.authenticatorSelection,
			excludeCredentials: (options.excludeCredentials || []).map(cred => ({
				id: base64urlToBuffer(cred.id),
				type: cred.type,
				transports: cred.transports,
			})),
		};

		// Perform WebAuthn ceremony
		const credential = await navigator.credentials.create({
			publicKey: publicKeyOptions
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
				attestationObject: bufferToBase64url(credential.response.attestationObject),
				transports: credential.response.getTransports ? credential.response.getTransports() : [],
			},
			type: credential.type,
			clientExtensionResults: credential.getClientExtensionResults(),
			authenticatorAttachment: credential.authenticatorAttachment,
		};

		// Submit to server
		const result = await fetch('/passkey/register', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token, response }),
		});

		const data = await result.json();

		if (data.success) {
			// Show success UI
			document.getElementById('register-container').style.display = 'none';
			document.getElementById('success-container').style.display = 'block';
		} else {
			throw new Error(data.error || 'Registration failed');
		}
	} catch (err) {
		console.error('Registration error:', err);
		status.textContent = err.message || 'Registration failed. Please try again.';
		status.className = 'status error';
		btn.disabled = false;
		btn.textContent = 'Register Passkey';
	}
}

// Check if WebAuthn is supported
if (!window.PublicKeyCredential) {
	document.getElementById('status').textContent = 'WebAuthn is not supported in this browser.';
	document.getElementById('status').className = 'status error';
	document.getElementById('register-btn').disabled = true;
} else {
	document.getElementById('register-btn').addEventListener('click', registerPasskey);
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
let registrationScriptHashPromise: Promise<string> | null = null;

/**
 * Get the script hash for the passkey registration script
 */
async function getPasskeyScriptHash(): Promise<string> {
	if (!registrationScriptHashPromise) {
		registrationScriptHashPromise = computeScriptHash(
			PASSKEY_REGISTRATION_SCRIPT,
		);
	}
	return registrationScriptHashPromise;
}

/**
 * Content Security Policy for the passkey UI (computed dynamically with script hash)
 */
export async function getPasskeyUiCsp(): Promise<string> {
	const scriptHash = await getPasskeyScriptHash();
	return `default-src 'none'; script-src ${scriptHash}; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`;
}

/**
 * Content Security Policy for error pages (no scripts)
 */
export const PASSKEY_ERROR_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

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

export interface PasskeyUIOptions {
	/** WebAuthn registration options */
	options: PublicKeyCredentialCreationOptionsJSON;
	/** Token for the registration */
	token: string;
	/** User's handle */
	handle: string;
}

/**
 * Render the passkey registration page
 */
export function renderPasskeyRegistrationPage(opts: PasskeyUIOptions): string {
	const { options, token, handle } = opts;

	// Serialize options for data attribute (HTML-escaped JSON)
	const optionsAttr = escapeHtml(JSON.stringify(options));
	const tokenAttr = escapeHtml(token);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Register Passkey</title>
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
			text-align: center;
		}

		.icon {
			width: 64px;
			height: 64px;
			border-radius: 12px;
			margin: 0 auto 16px;
			background: linear-gradient(135deg, #3b82f6, #8b5cf6);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 28px;
		}

		h1 {
			font-size: 20px;
			font-weight: 600;
			margin-bottom: 8px;
		}

		.handle {
			font-size: 14px;
			color: #60a5fa;
			margin-bottom: 24px;
		}

		.info {
			background: rgba(255, 255, 255, 0.05);
			border-radius: 12px;
			padding: 16px;
			margin-bottom: 24px;
			font-size: 14px;
			color: #9ca3af;
			text-align: left;
		}

		.info p {
			margin-bottom: 8px;
		}

		.info p:last-child {
			margin-bottom: 0;
		}

		.btn {
			width: 100%;
			padding: 14px 24px;
			border-radius: 8px;
			font-size: 16px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.2s;
			border: none;
			background: linear-gradient(135deg, #3b82f6, #2563eb);
			color: white;
		}

		.btn:hover:not(:disabled) {
			background: linear-gradient(135deg, #2563eb, #1d4ed8);
		}

		.btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.status {
			margin-top: 16px;
			font-size: 14px;
			min-height: 20px;
		}

		.status.error {
			color: #f87171;
		}

		.status.success {
			color: #22c55e;
		}

		.success-container {
			display: none;
		}

		.success-icon {
			width: 64px;
			height: 64px;
			border-radius: 50%;
			margin: 0 auto 16px;
			background: rgba(34, 197, 94, 0.1);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 32px;
			color: #22c55e;
		}

		.close-info {
			margin-top: 24px;
			font-size: 14px;
			color: #6b7280;
		}
	</style>
</head>
<body>
	<div class="container" id="register-container">
		<div class="icon">🔐</div>
		<h1>Register Passkey</h1>
		<p class="handle">@${escapeHtml(handle)}</p>

		<div class="info">
			<p>A passkey lets you sign in securely using your device's biometrics (Face ID, fingerprint) or PIN.</p>
			<p>Click the button below to create a passkey for this device.</p>
		</div>

		<button class="btn" id="register-btn">
			Register Passkey
		</button>

		<div class="status" id="status"></div>
	</div>

	<div class="container success-container" id="success-container">
		<div class="success-icon">✓</div>
		<h1>Passkey Registered!</h1>
		<p class="handle">@${escapeHtml(handle)}</p>

		<div class="info">
			<p>Your passkey has been registered successfully.</p>
			<p>You can now use it to sign in to your account.</p>
		</div>

		<p class="close-info">You can close this window.</p>
	</div>

	<script data-options="${optionsAttr}" data-token="${tokenAttr}">${PASSKEY_REGISTRATION_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Render an error page
 */
export function renderPasskeyErrorPage(
	error: string,
	description: string,
): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Passkey Error</title>
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
		<h1>Passkey Error</h1>
		<p>${escapeHtml(description)}</p>
		<p style="margin-top: 8px;"><code>${escapeHtml(error)}</code></p>
	</div>
</body>
</html>`;
}
