import { useEffect, useState, useCallback } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import {
	AuthKitProvider,
	SignInButton,
	type StatusAPIResponse,
} from "@farcaster/auth-kit";
import "@farcaster/auth-kit/styles.css";
import {
	createAccount,
	createAccountSiwf,
	login,
	loginWithSiwf,
	getAccountStatus,
	fetchFarcasterProfile,
	populateProfile,
	deleteAccount,
	getPdsUrl,
	setPdsUrl,
	requestCrawl,
	fetchDebugInfo,
	activateAccount,
	deactivateAccount,
	setRepoStatus,
	syncRelaySeq,
	getRelaySeq,
	emitIdentityEvent,
	emitAccountEvent,
	type SessionResponse,
	type SiwfCredentials,
	type FarcasterProfile,
	type PdsUrlConfig,
	type DebugInfo,
	type DebugField,
} from "./api";

type AppState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "browser-mode" }
	| { status: "authenticating" }
	| {
			status: "confirm-create";
			createAccount: () => Promise<void>;
			profile: FarcasterProfile;
	  }
	| { status: "authenticated"; session: SessionResponse; isNew: boolean };

// Settings component for managing DID identity configuration
function SettingsSection({ accessToken, pdsBase }: { accessToken: string; pdsBase: string }) {
	const [pdsConfig, setPdsConfig] = useState<PdsUrlConfig | null>(null);
	const [customUrl, setCustomUrl] = useState("");
	const [customVerificationKey, setCustomVerificationKey] = useState("");
	const [useCustom, setUseCustom] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	// Load current PDS URL configuration
	useEffect(() => {
		getPdsUrl(accessToken, pdsBase)
			.then((config) => {
				setPdsConfig(config);
				setUseCustom(config.isCustom);
				setCustomUrl(config.isCustom ? config.pdsUrl : "");
				setCustomVerificationKey(config.verificationKey || "");
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
			const newKey = useCustom && customVerificationKey ? customVerificationKey : null;
			const result = await setPdsUrl(accessToken, pdsBase, newUrl, newKey);
			setPdsConfig({
				pdsUrl: result.pdsUrl,
				isCustom: result.isCustom,
				defaultUrl: pdsConfig?.defaultUrl || "",
				verificationKey: newKey,
				defaultVerificationKey: pdsConfig?.defaultVerificationKey || "",
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
			<div className="settings-header">Identity Settings</div>

			{pdsConfig?.isCustom && (
				<div className="custom-pds-badge">Custom PDS Active</div>
			)}

			<div className="settings-description">
				Configure what your DID document advertises. By default, it points to
				your fid.is PDS. You can override it to point to an external PDS for
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
				<>
					<div className="custom-url-input">
						<input
							type="url"
							placeholder="https://your-pds.example.com"
							value={customUrl}
							onChange={(e) => setCustomUrl(e.target.value)}
							disabled={saving}
						/>
					</div>
					<div className="custom-url-input">
						<label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, display: "block" }}>
							Verification Key (optional)
						</label>
						<input
							type="text"
							placeholder="zQ3sh..."
							value={customVerificationKey}
							onChange={(e) => setCustomVerificationKey(e.target.value)}
							disabled={saving}
						/>
						{pdsConfig?.defaultVerificationKey && (
							<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
								Default key: {pdsConfig.defaultVerificationKey.slice(0, 20)}...
							</div>
						)}
					</div>
				</>
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

// Delete Account component
function DeleteAccountSection({
	accessToken,
	pdsBase,
	handle,
	onDeleted,
}: {
	accessToken: string;
	pdsBase: string;
	handle: string;
	onDeleted: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = async () => {
		setError(null);
		setDeleting(true);

		try {
			await deleteAccount(accessToken, pdsBase);
			onDeleted();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete account");
			setDeleting(false);
		}
	};

	if (!confirming) {
		return (
			<div className="settings-section danger-zone">
				<div className="settings-header">Danger Zone</div>
				<div className="settings-description">
					Permanently delete your AT Protocol identity and all associated data.
					This cannot be undone.
				</div>
				<button
					className="delete-button"
					onClick={() => setConfirming(true)}
				>
					Delete Account
				</button>
			</div>
		);
	}

	return (
		<div className="settings-section danger-zone">
			<div className="settings-header">Confirm Account Deletion</div>
			<div className="settings-description">
				This will permanently delete your AT Protocol identity, repository, and
				all stored data. Type your handle to confirm.
			</div>
			<input
				type="text"
				placeholder={handle}
				value={confirmText}
				onChange={(e) => setConfirmText(e.target.value)}
				disabled={deleting}
				className="confirm-handle-input"
			/>
			{error && <div className="settings-error">{error}</div>}
			<div className="delete-actions">
				<button
					className="cancel-button"
					onClick={() => {
						setConfirming(false);
						setConfirmText("");
						setError(null);
					}}
					disabled={deleting}
				>
					Cancel
				</button>
				<button
					className="delete-button"
					onClick={handleDelete}
					disabled={deleting || confirmText !== handle}
				>
					{deleting ? "Deleting..." : "Permanently Delete"}
				</button>
			</div>
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

/**
 * Extract FID from a Farcaster Quick Auth token (JWT sub claim).
 */
function fidFromToken(token: string): string | null {
	try {
		const payload = JSON.parse(atob(token.split(".")[1]!));
		return payload.sub ?? null;
	} catch {
		return null;
	}
}

/**
 * Derive the PDS base URL from a session handle.
 * Handle is `NNN.fid.is`, PDS base is `https://pds-NNN.fid.is`.
 */
function pdsBaseFromHandle(handle: string): string {
	return `https://pds-${handle}`;
}

// Debug page component
function DebugPage({
	session,
	onBack,
}: {
	session: SessionResponse;
	onBack: () => void;
}) {
	const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [seqInput, setSeqInput] = useState("");
	const [relaySeq, setRelaySeq] = useState<number | null>(null);
	const [actionStatus, setActionStatus] = useState<string | null>(null);
	const [expandedSections, setExpandedSections] = useState<Set<string>>(
		new Set(),
	);

	const loadDebugInfo = useCallback(async () => {
		setLoading(true);
		try {
			const [info, rSeq] = await Promise.all([
				fetchDebugInfo(session.accessJwt, session.did, session.handle),
				getRelaySeq(`pds-${session.handle}`),
			]);
			setDebugInfo(info);
			setRelaySeq(rSeq);
		} catch {
			setActionStatus("Failed to load debug info");
		} finally {
			setLoading(false);
		}
	}, [session.accessJwt, session.did, session.handle]);

	useEffect(() => {
		loadDebugInfo();
	}, [loadDebugInfo]);

	const toggleSection = (key: string) => {
		setExpandedSections((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const handleSetSeq = async () => {
		const seq = parseInt(seqInput, 10);
		if (isNaN(seq)) return;
		setActionStatus("Setting seq...");
		try {
			await syncRelaySeq(session.accessJwt, pdsBaseFromHandle(session.handle), seq);
			setActionStatus(`Seq set to ${seq}`);
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to set seq",
			);
		}
	};

	const handleActivate = async () => {
		setActionStatus("Activating...");
		try {
			await activateAccount(session.accessJwt, pdsBaseFromHandle(session.handle));
			setActionStatus("Account activated");
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to activate",
			);
		}
	};

	const handleDeactivate = async () => {
		setActionStatus("Deactivating...");
		try {
			await deactivateAccount(session.accessJwt, pdsBaseFromHandle(session.handle));
			setActionStatus("Account deactivated");
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to deactivate",
			);
		}
	};

	const handleMarkDeleted = async () => {
		setActionStatus("Marking as deleted...");
		try {
			await setRepoStatus(session.accessJwt, pdsBaseFromHandle(session.handle), "deleted");
			setActionStatus("Repo marked as deleted");
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to mark deleted",
			);
		}
	};

	const handleEmitIdentity = async () => {
		setActionStatus("Emitting identity event...");
		try {
			await emitIdentityEvent(session.accessJwt, session.handle);
			setActionStatus("Identity event emitted");
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to emit identity event",
			);
		}
	};

	const handleEmitAccount = async () => {
		setActionStatus("Emitting account event...");
		try {
			await emitAccountEvent(session.accessJwt, session.handle);
			setActionStatus("Account event emitted");
			await loadDebugInfo();
		} catch (err) {
			setActionStatus(
				err instanceof Error ? err.message : "Failed to emit account event",
			);
		}
	};

	const handleRequestCrawl = async () => {
		setActionStatus("Requesting crawl...");
		try {
			await requestCrawl(`pds-${session.handle}`);
			setActionStatus("Crawl requested");
		} catch {
			setActionStatus("Failed to request crawl");
		}
	};

	const fieldData = (f: DebugField | undefined) =>
		f && "data" in f ? f.data : null;

	const firehose = fieldData(debugInfo?.firehoseStatus) as {
		subscribers?: number;
		latestSeq?: number;
	} | null;
	const repoStatus = fieldData(debugInfo?.repoStatus) as {
		status?: string;
		rev?: string;
	} | null;

	const sections: Array<{ key: keyof DebugInfo; label: string }> = [
		{ key: "didDocument", label: "DID Document" },
		{ key: "atprotoDid", label: "atproto-did" },
		{ key: "describeServer", label: "Describe Server" },
		{ key: "repoStatus", label: "Repo Status" },
		{ key: "listRepos", label: "List Repos" },
		{ key: "describeRepo", label: "Describe Repo" },
		{ key: "profileRecord", label: "Profile Record" },
		{ key: "health", label: "Health" },
		{ key: "firehoseStatus", label: "Firehose Status" },
	];

	return (
		<div className="container">
			<div className="card">
				<div className="debug-header">
					<button className="debug-back-button" onClick={onBack}>
						Back
					</button>
					<h1 className="title">Debug</h1>
				</div>

				<div className="info">
					<div className="info-label">DID</div>
					<div className="info-value">{session.did}</div>
				</div>

				{loading ? (
					<div className="loading">Loading debug info...</div>
				) : (
					<>
						{/* Summary row */}
						<div className="debug-summary">
							<div className="debug-summary-item">
								<span className="debug-summary-label">PDS Seq</span>
								<span className="debug-summary-value">
									{firehose
										? firehose.latestSeq === null
											? "null"
											: (firehose.latestSeq ?? "—")
										: "—"}
								</span>
							</div>
							<div className="debug-summary-item">
								<span className="debug-summary-label">Relay Seq</span>
								<span className="debug-summary-value">
									{relaySeq === null ? "null" : (relaySeq ?? "—")}
								</span>
							</div>
							<div className="debug-summary-item">
								<span className="debug-summary-label">Status</span>
								<span className="debug-summary-value">
									{repoStatus?.status ?? "—"}
								</span>
							</div>
							<div className="debug-summary-item">
								<span className="debug-summary-label">Subs</span>
								<span className="debug-summary-value">
									{firehose?.subscribers ?? "—"}
								</span>
							</div>
						</div>

						{/* Actions */}
						<div className="debug-section">
							<div className="settings-header">Actions</div>

							<div className="debug-actions">
								<input
									type="number"
									className="debug-input"
									placeholder="Seq number"
									value={seqInput}
									onChange={(e) => setSeqInput(e.target.value)}
								/>
								<button
									onClick={handleSetSeq}
									disabled={!seqInput}
									className="debug-action-button"
								>
									Set Seq
								</button>
							</div>

							<div className="debug-actions">
								<button
									onClick={handleActivate}
									className="debug-action-button"
								>
									Activate
								</button>
								<button
									onClick={handleDeactivate}
									className="debug-action-button"
								>
									Deactivate
								</button>
								<button
									onClick={handleMarkDeleted}
									className="debug-action-button"
								>
									Mark Deleted
								</button>
							</div>

							<div className="debug-actions">
								<button
									onClick={handleEmitIdentity}
									className="debug-action-button"
								>
									Emit Identity
								</button>
								<button
									onClick={handleEmitAccount}
									className="debug-action-button"
								>
									Emit Account
								</button>
								<button
									onClick={handleRequestCrawl}
									className="debug-action-button"
								>
									Request Crawl
								</button>
								<button
									onClick={loadDebugInfo}
									className="debug-action-button"
								>
									Refresh
								</button>
							</div>

							{actionStatus && (
								<div className="debug-action-status">{actionStatus}</div>
							)}
						</div>

						{/* Collapsible endpoint sections */}
						{sections.map(({ key, label }) => {
							const field = debugInfo?.[key];
							const isError = field && "error" in field;
							const hasData = field && "data" in field;
							return (
								<div key={key} className="debug-section">
									<button
										className="debug-section-toggle"
										onClick={() => toggleSection(key)}
									>
										<span>
											{label}
											{isError && (
												<span className="debug-error-badge">err</span>
											)}
										</span>
										<span>
											{expandedSections.has(key) ? "−" : "+"}
										</span>
									</button>
									{expandedSections.has(key) && (
										<pre className={`debug-json${isError ? " debug-json-error" : ""}`}>
											{isError
												? (field as { error: string }).error
												: hasData
													? typeof (field as { data: unknown }).data === "string"
														? ((field as { data: unknown }).data as string)
														: JSON.stringify((field as { data: unknown }).data, null, 2)
													: "—"}
										</pre>
									)}
								</div>
							);
						})}
					</>
				)}
			</div>
		</div>
	);
}

function AppContent() {
	const [state, setState] = useState<AppState>({ status: "loading" });
	const [inFarcaster] = useState(() => isInFarcasterClient());
	const [showDebug, setShowDebug] = useState(false);

	/** After account creation, sync relay + populate profile */
	const finalizeNewAccount = useCallback(
		async (session: SessionResponse, profile: FarcasterProfile) => {
			const pdsBase = pdsBaseFromHandle(session.handle);
			await populateProfile(session.accessJwt, pdsBase, session.did, profile);
			requestCrawl(`pds-${session.handle}`);
			setState({ status: "authenticated", session, isNew: true });
		},
		[],
	);

	// Farcaster Quick Auth flow (for mini app mode)
	const initFarcaster = useCallback(async () => {
		try {
			await sdk.actions.ready();
			const { token } = await sdk.quickAuth.getToken();

			const fid = fidFromToken(token);
			if (!fid) throw new Error("Could not extract FID from token");

			// Step 1: Farcaster auth is done (Quick Auth verified the FID)
			// Step 2: Check fid-pds account existence + fetch profile in parallel
			const [accountExists, profile] = await Promise.all([
				getAccountStatus(fid),
				fetchFarcasterProfile(fid),
			]);

			if (accountExists) {
				// Account exists — login to get session tokens
				const session = await login(fid, token);
				setState({ status: "authenticated", session, isNew: false });
			} else {
				// No account — prompt to create
				setState({
					status: "confirm-create",
					profile,
					createAccount: async () => {
						setState({ status: "authenticating" });
						const session = await createAccount(fid, token);
						await finalizeNewAccount(session, profile);
					},
				});
			}
		} catch (err) {
			setState({
				status: "error",
				message: err instanceof Error ? err.message : "Something went wrong",
			});
		}
	}, [finalizeNewAccount]);

	// Handle SIWF success (browser mode)
	// SIWF verification is complete at this point (auth-kit verified the signature).
	// Now we check fid-pds account status and branch accordingly.
	const handleSiwfSuccess = useCallback(
		async (res: StatusAPIResponse) => {
			setState({ status: "authenticating" });
			try {
				if (!res.message || !res.signature || !res.fid) {
					throw new Error("Invalid SIWF response");
				}

				const credentials: SiwfCredentials = {
					message: res.message,
					signature: res.signature,
					fid: String(res.fid),
					nonce: res.nonce,
				};

				const fid = String(res.fid);

				// Check fid-pds account existence + fetch profile in parallel
				const [accountExists, profile] = await Promise.all([
					getAccountStatus(fid),
					fetchFarcasterProfile(fid),
				]);

				if (accountExists) {
					// Account exists — login to get session tokens
					const session = await loginWithSiwf(fid, credentials);
					setState({ status: "authenticated", session, isNew: false });
				} else {
					// No account — prompt to create
					setState({
						status: "confirm-create",
						profile,
						createAccount: async () => {
							setState({ status: "authenticating" });
							const session = await createAccountSiwf(fid, credentials);
							await finalizeNewAccount(session, profile);
						},
					});
				}
			} catch (err) {
				setState({
					status: "error",
					message:
						err instanceof Error ? err.message : "Authentication failed",
				});
			}
		},
		[finalizeNewAccount],
	);

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

					<div
						className="siwf-button-container"
						ref={(el) => {
							if (!el) return;
							// Strip SVG <title> elements from auth-kit QR code to prevent
							// browser tooltip from covering the QR code on hover
							const observer = new MutationObserver(() => {
								el.ownerDocument
									.querySelectorAll(".fc-authkit-qrcode-dialog svg title")
									.forEach((t) => t.remove());
							});
							observer.observe(el.ownerDocument.body, { childList: true, subtree: true });
						}}
					>
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

	if (state.status === "confirm-create") {
		const { profile } = state;
		const atHandle = profile.fname
			? `${profile.fname}.farcaster.social`
			: null;
		const hasEnsName =
			profile.username &&
			profile.username !== profile.fname &&
			profile.username.includes(".");
		return (
			<div className="container">
				<div className="card">
					<h1 className="title">Create Account</h1>
					<p className="subtitle">
						No AT Protocol account found for your Farcaster identity.
					</p>

					{(profile.pfpUrl || profile.displayName || profile.fname || profile.bio) && (
						<div className="preview-profile">
							{profile.pfpUrl && (
								<img
									className="preview-avatar"
									src={profile.pfpUrl}
									alt=""
								/>
							)}
							<div className="preview-profile-text">
								{profile.displayName && (
									<div className="preview-display-name">
										{profile.displayName}
									</div>
								)}
								{profile.fname && (
									<div className="preview-fname">
										@{profile.fname} on Farcaster
									</div>
								)}
								{profile.bio && (
									<div className="preview-bio">{profile.bio}</div>
								)}
							</div>
						</div>
					)}

					{atHandle && (
						<div className="info">
							<div className="info-label">Your AT Protocol Handle</div>
							<div className="info-value">@{atHandle}</div>
						</div>
					)}

					{hasEnsName && (
						<div className="preview-warning">
							Your Farcaster username is{" "}
							<strong>{profile.username}</strong>, but AT Protocol
							handles must be valid DNS names. Your fname{" "}
							<strong>{profile.fname}</strong> will be used instead.
						</div>
					)}

					<p
						style={{
							marginBottom: 24,
							color: "var(--muted)",
							fontSize: 14,
						}}
					>
						Would you like to create a new AT Protocol account linked to your
						Farcaster identity?
					</p>

					<button onClick={state.createAccount}>Create Account</button>
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

	if (showDebug) {
		return (
			<DebugPage
				session={session}
				onBack={() => setShowDebug(false)}
			/>
		);
	}

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

				<SettingsSection accessToken={session.accessJwt} pdsBase={pdsBaseFromHandle(session.handle)} />

				<DeleteAccountSection
					accessToken={session.accessJwt}
					pdsBase={pdsBaseFromHandle(session.handle)}
					handle={session.handle}
					onDeleted={() => setState({ status: "browser-mode" })}
				/>

				<div className="settings-section">
					<button
						className="debug-toggle-button"
						onClick={() => setShowDebug(true)}
					>
						Debug Info
					</button>
				</div>
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
