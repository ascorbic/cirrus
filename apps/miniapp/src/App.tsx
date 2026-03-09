import { useEffect, useState, useCallback } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import {
	AuthKitProvider,
	SignInButton,
	type StatusAPIResponse,
} from "@farcaster/auth-kit";
import "@farcaster/auth-kit/styles.css";
import { startRegistration } from "@simplewebauthn/browser";
import {
	createAccountFarcasterMini,
	createAccountSiwf,
	login,
	loginSiwf,
	getAccountStatus,
	fetchFarcasterProfile,
	populateProfile,
	deleteAccount,
	getPdsUrl,
	setPdsUrl,
	getHandle,
	setHandle,
	verifyFnameOwnership,
	requestCrawl,
	fetchDebugInfo,
	activateAccount,
	deactivateAccount,
	setRepoStatus,
	syncRelaySeq,
	getRelaySeq,
	emitIdentityEvent,
	emitAccountEvent,
	getPasskeyRegistrationOptions,
	registerPasskey,
	listPasskeys,
	deletePasskeyApi,
	renamePasskeyApi,
	joinWaitlistApi,
	type SessionResponse,
	type SiwfCredentials,
	type FarcasterProfile,
	type PdsUrlConfig,
	type HandleConfig,
	type DebugInfo,
	type DebugField,
	type PasskeyInfo,
} from "./api";

type AppState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "browser-mode" }
	| { status: "authenticating" }
	| {
			status: "confirm-create";
			fid: string;
			createAccountFarcasterMini: (handle?: string) => Promise<void>;
			profile: FarcasterProfile;
	  }
	| {
			status: "waitlist";
			fid: string;
			profile: FarcasterProfile;
			alreadyWaitlisted: boolean;
			joinWaitlist: () => Promise<void>;
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

// Handle settings component
function HandleSection({
	accessToken,
	pdsBase,
	did,
	onHandleChanged,
}: {
	accessToken: string;
	pdsBase: string;
	did: string;
	onHandleChanged: (newHandle: string) => void;
}) {
	const [handleConfig, setHandleConfig] = useState<HandleConfig | null>(null);
	const [fname, setFname] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	// Extract FID from DID (did:web:NNN.fid.is → NNN)
	const fid = did.replace("did:web:", "").split(".")[0]!;

	const fnameHandle = fname ? `${fname}.farcaster.social` : null;

	useEffect(() => {
		Promise.all([
			getHandle(accessToken, pdsBase),
			fetchFarcasterProfile(fid).then((p) => p.fname),
		])
			.then(([config, fetchedFname]) => {
				setHandleConfig(config);
				setFname(fetchedFname);
				setLoading(false);
			})
			.catch((err) => {
				setError(err.message);
				setLoading(false);
			});
	}, [accessToken, pdsBase, fid]);

	if (loading) {
		return (
			<div className="settings-section">
				<div className="settings-header">Handle</div>
				<div style={{ color: "var(--muted)", fontSize: 14 }}>Loading...</div>
			</div>
		);
	}

	if (!handleConfig) {
		return null;
	}

	const currentHandle = handleConfig.handle;
	const domain = import.meta.env.VITE_PDS_DOMAIN || "fid.is";
	const defaultHandle = `${fid}.${domain}`;
	const canSwitchToFname = fnameHandle !== null && currentHandle !== fnameHandle;
	const canSwitchToDefault = currentHandle !== defaultHandle;

	const switchHandle = async (newHandle: string | null) => {
		setError(null);
		setSuccess(false);
		setSaving(true);

		try {
			// Validate FNAME ownership client-side before setting
			if (newHandle && fname) {
				const verified = await verifyFnameOwnership(fname, fid);
				if (!verified) {
					setError("Could not verify FNAME ownership");
					setSaving(false);
					return;
				}
			}

			const result = await setHandle(accessToken, pdsBase, newHandle);
			setHandleConfig({ handle: result.handle });
			onHandleChanged(result.handle);
			setSuccess(true);
			setTimeout(() => setSuccess(false), 3000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update handle");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="settings-section">
			<div className="settings-header">Handle</div>
			<div className="current-pds">
				<span className="label">Current:</span>
				<span className="value">@{currentHandle}</span>
			</div>
			{error && <div className="settings-error">{error}</div>}
			{success && <div className="settings-success">Handle updated!</div>}
			{canSwitchToFname && (
				<button
					onClick={() => switchHandle(fnameHandle)}
					disabled={saving}
					className="save-button"
				>
					{saving ? "Switching..." : `Switch to @${fnameHandle}`}
				</button>
			)}
			{canSwitchToDefault && (
				<button
					onClick={() => switchHandle(null)}
					disabled={saving}
					className="save-button"
					style={canSwitchToFname ? { marginTop: 8 } : undefined}
				>
					{saving ? "Switching..." : `Switch to @${defaultHandle}`}
				</button>
			)}
		</div>
	);
}

// Passkey management component
function PasskeySection({ accessToken, pdsBase }: { accessToken: string; pdsBase: string }) {
	const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	const loadPasskeys = useCallback(async () => {
		try {
			const list = await listPasskeys(accessToken, pdsBase);
			setPasskeys(list);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load passkeys");
		} finally {
			setLoading(false);
		}
	}, [accessToken, pdsBase]);

	useEffect(() => {
		loadPasskeys();
	}, [loadPasskeys]);

	const handleAdd = async () => {
		setError(null);
		setSuccess(null);
		setAdding(true);

		try {
			// Step 1: Get registration options from the server
			const { options, token } = await getPasskeyRegistrationOptions(accessToken, pdsBase);

			// Step 2: Start the WebAuthn ceremony in the browser
			const attResp = await startRegistration({ optionsJSON: options });

			// Step 3: Send the response back to the server for verification
			const defaultName = `Passkey ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
			await registerPasskey(accessToken, pdsBase, token, attResp, defaultName);

			setSuccess("Passkey registered!");
			setTimeout(() => setSuccess(null), 3000);
			await loadPasskeys();
		} catch (err) {
			if (err instanceof Error && err.name === "NotAllowedError") {
				setError("Passkey registration was cancelled");
			} else {
				setError(err instanceof Error ? err.message : "Failed to add passkey");
			}
		} finally {
			setAdding(false);
		}
	};

	const handleDelete = async (credentialId: string) => {
		setError(null);
		setSuccess(null);
		setDeleting(credentialId);

		try {
			await deletePasskeyApi(accessToken, pdsBase, credentialId);
			setSuccess("Passkey deleted");
			setTimeout(() => setSuccess(null), 3000);
			await loadPasskeys();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete passkey");
		} finally {
			setDeleting(null);
		}
	};

	const startRename = (pk: PasskeyInfo) => {
		setRenaming(pk.id);
		setRenameValue(pk.name || "");
	};

	const handleRename = async (credentialId: string) => {
		const trimmed = renameValue.trim();
		if (!trimmed) return;
		setError(null);
		try {
			await renamePasskeyApi(accessToken, pdsBase, credentialId, trimmed);
			setRenaming(null);
			await loadPasskeys();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to rename passkey");
		}
	};

	if (loading) {
		return (
			<div className="settings-section">
				<div className="settings-header">Passkeys</div>
				<div style={{ color: "var(--muted)", fontSize: 14 }}>Loading...</div>
			</div>
		);
	}

	return (
		<div className="settings-section">
			<div className="settings-header">Passkeys</div>
			<div className="settings-description">
				Passkeys let you sign in with biometrics or your device's security key.
			</div>

			{passkeys.length > 0 && (
				<div className="passkey-list">
					{passkeys.map((pk) => (
						<div key={pk.id} className="passkey-item">
							<div className="passkey-info">
								{renaming === pk.id ? (
									<form className="passkey-rename-form" onSubmit={(e) => { e.preventDefault(); handleRename(pk.id); }}>
										<input
											className="passkey-rename-input"
											value={renameValue}
											onChange={(e) => setRenameValue(e.target.value)}
											autoFocus
											maxLength={100}
											onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
										/>
										<button type="submit" className="passkey-rename-save">Save</button>
										<button type="button" className="passkey-rename-cancel" onClick={() => setRenaming(null)}>Cancel</button>
									</form>
								) : (
									<div className="passkey-name" onClick={() => startRename(pk)} title="Click to rename">
										{pk.name || "Unnamed passkey"}
									</div>
								)}
								<div className="passkey-meta">
									Added {new Date(pk.createdAt).toLocaleDateString()}
									{pk.lastUsedAt && (
										<> · Last used {new Date(pk.lastUsedAt).toLocaleDateString()}</>
									)}
								</div>
							</div>
							{renaming !== pk.id && (
								<button
									className="passkey-delete-button"
									onClick={() => handleDelete(pk.id)}
									disabled={deleting === pk.id}
								>
									{deleting === pk.id ? "..." : "Delete"}
								</button>
							)}
						</div>
					))}
				</div>
			)}

			{passkeys.length === 0 && (
				<div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
					No passkeys registered yet.
				</div>
			)}

			{error && <div className="settings-error">{error}</div>}
			{success && <div className="settings-success">{success}</div>}

			<button
				onClick={handleAdd}
				disabled={adding}
				className="save-button"
			>
				{adding ? "Registering..." : "Add Passkey"}
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

// Confirm-create screen with handle selection
function ConfirmCreateScreen({
	fid,
	profile,
	onCreateAccount,
}: {
	fid: string;
	profile: FarcasterProfile;
	onCreateAccount: (handle?: string) => Promise<void>;
}) {
	const fnameHandle = profile.fname
		? `${profile.fname}.farcaster.social`
		: null;
	const hasEnsName =
		profile.username &&
		profile.username !== profile.fname &&
		profile.username.includes(".");

	// Default to FNAME handle if available
	const [selectedHandle, setSelectedHandle] = useState<string | undefined>(
		fnameHandle ?? undefined,
	);
	const [fnameVerified, setFnameVerified] = useState<boolean | null>(null);
	const [verifying, setVerifying] = useState(false);

	// Verify FNAME ownership when FNAME handle is selected
	useEffect(() => {
		if (!selectedHandle || !profile.fname) {
			setFnameVerified(null);
			return;
		}
		setVerifying(true);
		verifyFnameOwnership(profile.fname, fid)
			.then((ok) => {
				setFnameVerified(ok);
				setVerifying(false);
			})
			.catch(() => {
				setFnameVerified(false);
				setVerifying(false);
			});
	}, [selectedHandle, profile.fname, fid]);

	const canCreate = !selectedHandle || (fnameVerified === true && !verifying);

	return (
		<div className="container">
			<div className="card">
				<h1 className="title">Join Bluesky</h1>
				<p className="subtitle">
					Use your Farcaster identity to create your Bluesky account.
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

				{fnameHandle ? (
					<div className="info">
						<div className="info-label">Choose your handle</div>
						<div className="handle-options">
							<label className="handle-option">
								<input
									type="radio"
									name="handle"
									checked={selectedHandle === fnameHandle}
									onChange={() => setSelectedHandle(fnameHandle)}
								/>
								<span>@{fnameHandle}</span>
								{selectedHandle === fnameHandle && verifying && (
									<span style={{ color: "var(--muted)", fontSize: 12 }}>
										(verifying...)
									</span>
								)}
								{selectedHandle === fnameHandle && fnameVerified === false && !verifying && (
									<span style={{ color: "var(--error)", fontSize: 12 }}>
										(could not verify ownership)
									</span>
								)}
							</label>
							<label className="handle-option">
								<input
									type="radio"
									name="handle"
									checked={selectedHandle === undefined}
									onChange={() => setSelectedHandle(undefined)}
								/>
								<span>Use default FID handle</span>
							</label>
						</div>
					</div>
				) : null}

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
					This creates a Bluesky account linked to your Farcaster identity. Takes about 10 seconds.
				</p>

				<button
					onClick={() => onCreateAccount(selectedHandle)}
					disabled={!canCreate}
				>
					Join Bluesky
				</button>
			</div>
		</div>
	);
}

/**
 * Derive the PDS hostname from a session DID.
 * DID is `did:web:NNN.fid.is` → `pds-NNN.fid.is`
 */
function pdsHostnameFromDid(did: string): string {
	const host = did.replace("did:web:", "");
	return `pds-${host}`;
}

/**
 * Derive the PDS base URL from a session DID.
 * DID is `did:web:NNN.fid.is`, PDS base is `https://pds-NNN.fid.is`.
 */
function pdsBaseFromDid(did: string): string {
	return `https://${pdsHostnameFromDid(did)}`;
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
				fetchDebugInfo(session.accessJwt, session.did, pdsBaseFromDid(session.did)),
				getRelaySeq(pdsHostnameFromDid(session.did)),
			]);
			setDebugInfo(info);
			setRelaySeq(rSeq);
		} catch {
			setActionStatus("Failed to load debug info");
		} finally {
			setLoading(false);
		}
	}, [session.accessJwt, session.did]);

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
			await syncRelaySeq(session.accessJwt, pdsBaseFromDid(session.did), seq);
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
			await activateAccount(session.accessJwt, pdsBaseFromDid(session.did));
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
			await deactivateAccount(session.accessJwt, pdsBaseFromDid(session.did));
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
			await setRepoStatus(session.accessJwt, pdsBaseFromDid(session.did), "deleted");
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
			await emitIdentityEvent(session.accessJwt, pdsBaseFromDid(session.did));
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
			await emitAccountEvent(session.accessJwt, pdsBaseFromDid(session.did));
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
			await requestCrawl(pdsHostnameFromDid(session.did));
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

function WaitlistScreen({
	profile,
	alreadyWaitlisted,
	onJoinWaitlist,
}: {
	profile: FarcasterProfile;
	alreadyWaitlisted: boolean;
	onJoinWaitlist: () => Promise<void>;
}) {
	const [joined, setJoined] = useState(alreadyWaitlisted);
	const [joining, setJoining] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleJoin = async () => {
		setError(null);
		setJoining(true);
		try {
			await onJoinWaitlist();
			setJoined(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to join waitlist");
		} finally {
			setJoining(false);
		}
	};

	return (
		<div className="container">
			<div className="card">
				{joined ? (
					<>
						<h1 className="title">You're on the list</h1>
						<p className="subtitle">We're letting people in gradually.</p>

						{profile.pfpUrl && (
							<div className="preview-profile" style={{ justifyContent: "center" }}>
								<img className="preview-avatar" src={profile.pfpUrl} alt="" />
							</div>
						)}

						<p
							style={{
								marginTop: 24,
								color: "var(--muted)",
								fontSize: 14,
								textAlign: "center",
							}}
						>
							We'll open the door for you shortly.
						</p>
					</>
				) : (
					<>
						<h1 className="title">Early Access</h1>
						<p className="subtitle">
							fid.is is opening Bluesky accounts to a small group first.
						</p>

						{(profile.pfpUrl || profile.displayName || profile.fname) && (
							<div className="preview-profile">
								{profile.pfpUrl && (
									<img className="preview-avatar" src={profile.pfpUrl} alt="" />
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
								</div>
							</div>
						)}

						{error && <div className="settings-error">{error}</div>}

						<button onClick={handleJoin} disabled={joining}>
							{joining ? "Requesting..." : "Request Early Access"}
						</button>

						<p
							style={{
								marginTop: 16,
								color: "var(--muted)",
								fontSize: 13,
								textAlign: "center",
							}}
						>
							Spots are limited. Request now to secure your place.
						</p>
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
			const pdsBase = pdsBaseFromDid(session.did);
			await populateProfile(session.accessJwt, pdsBase, session.did, profile);
			requestCrawl(pdsHostnameFromDid(session.did));
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
			const [accountStatus, profile] = await Promise.all([
				getAccountStatus(fid),
				fetchFarcasterProfile(fid),
			]);

			if (accountStatus.exists) {
				// Account exists — login to get session tokens
				const session = await login(fid, token);
				setState({ status: "authenticated", session, isNew: false });
			} else if (accountStatus.allowed) {
				// Allowed to create — prompt to create
				setState({
					status: "confirm-create",
					fid,
					profile,
					createAccountFarcasterMini: async (handle?: string) => {
						setState({ status: "authenticating" });
						const session = await createAccountFarcasterMini(fid, token, handle);
						await finalizeNewAccount(session, profile);
					},
				});
			} else {
				// Not allowed — show waitlist screen
				setState({
					status: "waitlist",
					fid,
					profile,
					alreadyWaitlisted: accountStatus.waitlisted,
					joinWaitlist: async () => {
						await joinWaitlistApi(fid, { farcasterToken: token });
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
				const [accountStatus, profile] = await Promise.all([
					getAccountStatus(fid),
					fetchFarcasterProfile(fid),
				]);

				if (accountStatus.exists) {
					// Account exists — login to get session tokens
					const session = await loginSiwf(fid, credentials);
					setState({ status: "authenticated", session, isNew: false });
				} else if (accountStatus.allowed) {
					// Allowed to create — prompt to create
					setState({
						status: "confirm-create",
						fid,
						profile,
						createAccountFarcasterMini: async (handle?: string) => {
							setState({ status: "authenticating" });
							const session = await createAccountSiwf(fid, credentials, handle);
							await finalizeNewAccount(session, profile);
						},
					});
				} else {
					// Not allowed — show waitlist screen
					setState({
						status: "waitlist",
						fid,
						profile,
						alreadyWaitlisted: accountStatus.waitlisted,
						joinWaitlist: async () => {
							await joinWaitlistApi(fid, credentials);
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
					<h1 className="title">fid.is</h1>
					<p className="subtitle">Your Farcaster identity on Bluesky</p>

					<p style={{ marginBottom: 24, color: "var(--muted)", fontSize: 14 }}>
						One account. Two networks. Sign in with Farcaster to get started.
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
						Use your Farcaster account to join Bluesky and the AT Protocol network.
					</p>
				</div>
			</div>
		);
	}

	if (state.status === "waitlist") {
		return (
			<WaitlistScreen
				profile={state.profile}
				alreadyWaitlisted={state.alreadyWaitlisted}
				onJoinWaitlist={state.joinWaitlist}
			/>
		);
	}

	if (state.status === "confirm-create") {
		return (
			<ConfirmCreateScreen
				fid={state.fid}
				profile={state.profile}
				onCreateAccount={state.createAccountFarcasterMini}
			/>
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
					{isNew ? "You're on Bluesky" : "Welcome Back"}
				</h1>
				<p className="subtitle">
					{isNew
						? "Your account is live on the Bluesky network."
						: "Connected to your account."}
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
						Sign in to any Bluesky app with your handle above. Your Farcaster identity is your key.
					</p>
				)}

				<HandleSection
					accessToken={session.accessJwt}
					pdsBase={pdsBaseFromDid(session.did)}
					did={session.did}
					onHandleChanged={(newHandle) => {
						setState({
							status: "authenticated",
							session: { ...session, handle: newHandle },
							isNew: false,
						});
					}}
				/>

				<SettingsSection accessToken={session.accessJwt} pdsBase={pdsBaseFromDid(session.did)} />

				<PasskeySection accessToken={session.accessJwt} pdsBase={pdsBaseFromDid(session.did)} />

				<DeleteAccountSection
					accessToken={session.accessJwt}
					pdsBase={pdsBaseFromDid(session.did)}
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
