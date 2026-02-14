import { useEffect, useState, useCallback } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import {
	AuthKitProvider,
	SignInButton,
	type StatusAPIResponse,
} from "@farcaster/auth-kit";
import "@farcaster/auth-kit/styles.css";
import {
	loginOrCreate,
	loginWithSiwf,
	getPdsUrl,
	setPdsUrl,
	type SessionResponse,
	type PdsUrlConfig,
} from "./api";

type AppState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "browser-mode" }
	| { status: "authenticating" }
	| { status: "authenticated"; session: SessionResponse; isNew: boolean };

// Settings component for managing PDS URL
function SettingsSection({ accessToken }: { accessToken: string }) {
	const [pdsConfig, setPdsConfig] = useState<PdsUrlConfig | null>(null);
	const [customUrl, setCustomUrl] = useState("");
	const [useCustom, setUseCustom] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	// Load current PDS URL configuration
	useEffect(() => {
		getPdsUrl(accessToken)
			.then((config) => {
				setPdsConfig(config);
				setUseCustom(config.isCustom);
				setCustomUrl(config.isCustom ? config.pdsUrl : "");
				setLoading(false);
			})
			.catch((err) => {
				setError(err.message);
				setLoading(false);
			});
	}, [accessToken]);

	const handleSave = async () => {
		setError(null);
		setSuccess(false);
		setSaving(true);

		try {
			const newUrl = useCustom ? customUrl : null;
			const result = await setPdsUrl(accessToken, newUrl);
			setPdsConfig({
				pdsUrl: result.pdsUrl,
				isCustom: result.isCustom,
				defaultUrl: pdsConfig?.defaultUrl || "",
			});
			setSuccess(true);
			setTimeout(() => setSuccess(false), 3000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="settings-section">
				<div className="settings-header">Settings</div>
				<div style={{ color: "var(--muted)", fontSize: 14 }}>Loading...</div>
			</div>
		);
	}

	return (
		<div className="settings-section">
			<div className="settings-header">PDS Settings</div>

			{pdsConfig?.isCustom && (
				<div className="custom-pds-badge">Custom PDS Active</div>
			)}

			<div className="settings-description">
				Configure where your AT Protocol repository is hosted. By default, it's
				hosted on fid.is. You can point your DID to a different PDS for
				migration or self-hosting.
			</div>

			<div className="pds-toggle">
				<label className="toggle-label">
					<input
						type="checkbox"
						checked={useCustom}
						onChange={(e) => setUseCustom(e.target.checked)}
					/>
					<span>Use custom PDS URL</span>
				</label>
			</div>

			{useCustom && (
				<div className="custom-url-input">
					<input
						type="url"
						placeholder="https://your-pds.example.com"
						value={customUrl}
						onChange={(e) => setCustomUrl(e.target.value)}
						disabled={saving}
					/>
				</div>
			)}

			<div className="current-pds">
				<span className="label">Current PDS:</span>
				<span className="value">{pdsConfig?.pdsUrl}</span>
			</div>

			{!useCustom && pdsConfig?.defaultUrl && (
				<div className="default-pds-note">
					Using default: {pdsConfig.defaultUrl}
				</div>
			)}

			{error && <div className="settings-error">{error}</div>}
			{success && <div className="settings-success">Settings saved!</div>}

			<button
				onClick={handleSave}
				disabled={saving || (useCustom && !customUrl)}
				className="save-button"
			>
				{saving ? "Saving..." : "Save Changes"}
			</button>
		</div>
	);
}

/**
 * Check if we're running inside a Farcaster client.
 */
function isInFarcasterClient(): boolean {
	if (typeof window === "undefined") return false;

	const params = new URLSearchParams(window.location.search);
	if (params.has("fc-frame")) return true;

	// Check if we're in an iframe (mini apps run in iframes)
	try {
		if (window.parent !== window && window.parent.location.href) return true;
	} catch {
		// Cross-origin iframe - likely Farcaster
		if (window.parent !== window) return true;
	}

	return false;
}

// Auth-kit configuration
// In production, domain/siweUri will use the actual host
// In local dev, we override to match the PDS's WEBFID_DOMAIN
const AUTH_DOMAIN = import.meta.env.VITE_AUTH_DOMAIN || window.location.host;
const AUTH_URI = import.meta.env.VITE_AUTH_URI || window.location.origin;

const authKitConfig = {
	rpcUrl: "https://mainnet.optimism.io",
	domain: AUTH_DOMAIN,
	siweUri: AUTH_URI,
};

function AppContent() {
	const [state, setState] = useState<AppState>({ status: "loading" });
	const [inFarcaster] = useState(() => isInFarcasterClient());

	// Farcaster Quick Auth flow (for mini app mode)
	const initFarcaster = useCallback(async () => {
		try {
			await sdk.actions.ready();
			const { token } = await sdk.quickAuth.getToken();
			const result = await loginOrCreate(token);
			setState({
				status: "authenticated",
				session: result,
				isNew: result.isNew,
			});
		} catch (err) {
			setState({
				status: "error",
				message: err instanceof Error ? err.message : "Something went wrong",
			});
		}
	}, []);

	// Handle SIWF success (browser mode)
	const handleSiwfSuccess = useCallback(async (res: StatusAPIResponse) => {
		setState({ status: "authenticating" });
		try {
			if (!res.message || !res.signature || !res.fid) {
				throw new Error("Invalid SIWF response");
			}

			const result = await loginWithSiwf({
				message: res.message,
				signature: res.signature,
				fid: res.fid,
				nonce: res.nonce,
			});

			setState({
				status: "authenticated",
				session: result,
				isNew: result.isNew,
			});
		} catch (err) {
			setState({
				status: "error",
				message: err instanceof Error ? err.message : "Authentication failed",
			});
		}
	}, []);

	useEffect(() => {
		if (inFarcaster) {
			initFarcaster();
		} else {
			setState({ status: "browser-mode" });
		}
	}, [inFarcaster, initFarcaster]);

	if (state.status === "loading" || state.status === "authenticating") {
		return (
			<div className="container">
				<div className="loading">
					{state.status === "authenticating"
						? "Authenticating..."
						: "Connecting..."}
				</div>
			</div>
		);
	}

	if (state.status === "browser-mode") {
		return (
			<div className="container">
				<div className="card">
					<h1 className="title">WebFID</h1>
					<p className="subtitle">AT Protocol on Farcaster</p>

					<p style={{ marginBottom: 24, color: "var(--muted)", fontSize: 14 }}>
						Create or access your AT Protocol account using your Farcaster
						identity.
					</p>

					<div className="siwf-button-container">
						<SignInButton onSuccess={handleSiwfSuccess} />
					</div>

					<p
						style={{
							marginTop: 24,
							color: "var(--muted)",
							fontSize: 12,
							textAlign: "center",
						}}
					>
						Sign in with your Farcaster account to create or access your AT
						Protocol identity.
					</p>
				</div>
			</div>
		);
	}

	if (state.status === "error") {
		return (
			<div className="container">
				<div className="card">
					<h1 className="title">Error</h1>
					<p className="error">{state.message}</p>
					<button onClick={() => window.location.reload()}>Try Again</button>
				</div>
			</div>
		);
	}

	const { session, isNew } = state;

	return (
		<div className="container">
			<div className="card">
				<h1 className="title">
					{isNew ? "Welcome to WebFID!" : "Welcome Back!"}
				</h1>
				<p className="subtitle">
					{isNew
						? "Your AT Protocol account has been created."
						: "You're connected to your AT Protocol account."}
				</p>

				<div className="info">
					<div className="info-label">Your DID</div>
					<div className="info-value">{session.did}</div>
				</div>

				<div className="info">
					<div className="info-label">Handle</div>
					<div className="info-value">@{session.handle}</div>
				</div>

				{isNew && (
					<p className="success">
						Your account is ready! You can now use Bluesky clients with your
						Farcaster identity.
					</p>
				)}

				<SettingsSection accessToken={session.accessJwt} />
			</div>
		</div>
	);
}

export function App() {
	return (
		<AuthKitProvider config={authKitConfig}>
			<AppContent />
		</AuthKitProvider>
	);
}
