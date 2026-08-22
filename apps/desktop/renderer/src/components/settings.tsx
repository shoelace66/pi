import { useState } from "react";
import type { DesktopModelsProviders, DesktopProvider } from "../../../shared/view-models.ts";
import { useI18n } from "../i18n.tsx";
import { CloseIcon, MoonIcon, SettingsIcon, SunIcon } from "../icons.tsx";
import type { ThemeState } from "../theme.ts";
import { applyTheme, saveThemeState } from "../theme.ts";
import { cn } from "../utils.ts";

export interface SettingsData {
	readonly cwd: string;
	readonly dataDirectory: string;
	readonly agentDirectory: string;
	readonly scheduler: string;
	readonly productName: string;
	readonly productVersion: string;
	readonly coreVersion: string;
	readonly buildId: string;
	readonly sourceRevision: string;
	readonly canLaunchAtLogin: boolean;
	readonly launchAtLogin: boolean;
}
export interface SettingsDialogProps {
	readonly settings: SettingsData;
	readonly adapters: readonly string[];
	readonly themeState: ThemeState;
	readonly onThemeChange: (state: ThemeState) => void;
	readonly onClose: () => void;
	readonly activeSession: boolean;
	readonly projectTrusted: boolean;
	readonly onProjectTrustChange: (trusted: boolean) => void;
	readonly onLaunchAtLoginChange: (enabled: boolean) => void;
	readonly modelsProviders?: DesktopModelsProviders;
	readonly modelsLoading: boolean;
	readonly modelsError?: string;
	readonly onRefreshModels: () => void;
	readonly onSaveProviderApiKey: (provider: string, apiKey: string) => Promise<void>;
	readonly onRemoveProviderApiKey: (provider: string) => Promise<void>;
	readonly onLoginProvider: (provider: string) => Promise<void>;
	readonly onLogoutProvider: (provider: string) => Promise<void>;
}
type Section = "appearance" | "models" | "permissions" | "advanced";

export function SettingsDialog({
	settings,
	adapters,
	themeState,
	onThemeChange,
	onClose,
	activeSession,
	projectTrusted,
	onProjectTrustChange,
	onLaunchAtLoginChange,
	modelsProviders,
	modelsLoading,
	modelsError,
	onRefreshModels,
	onSaveProviderApiKey,
	onRemoveProviderApiKey,
	onLoginProvider,
	onLogoutProvider,
}: SettingsDialogProps): React.JSX.Element {
	const { language, setLanguage, t } = useI18n();
	const [section, setSection] = useState<Section>("appearance");
	function setMode(mode: ThemeState["mode"]): void {
		const next = { mode };
		applyTheme(next);
		saveThemeState(next);
		onThemeChange(next);
	}
	return (
		<div className="modal-backdrop">
			<div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
				<header className="modal-header">
					<div>
						<h2 id="settings-title">{t("Settings")}</h2>
						<p>{t("Configure the AutoPi experience.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close settings")}>
						<CloseIcon width={17} height={17} />
					</button>
				</header>
				<div className="settings-layout">
					<nav>
						{(["appearance", "models", "permissions", "advanced"] as const).map((item) => (
							<button
								type="button"
								key={item}
								className={cn(section === item && "active")}
								onClick={() => setSection(item)}
							>
								{t(item === "models" ? "Models & Providers" : item[0].toUpperCase() + item.slice(1))}
							</button>
						))}
					</nav>
					<div className="settings-content">
						{section === "appearance" && (
							<>
								<h3>{t("Appearance")}</h3>
								<p className="section-description">
									{t("AutoPi uses one consistent visual system in light and dark modes.")}
								</p>
								<div className="theme-choice-row">
									<button
										type="button"
										className={cn("theme-choice", themeState.mode === "dark" && "active")}
										onClick={() => setMode("dark")}
									>
										<MoonIcon width={17} height={17} />
										<span>
											<strong>{t("AutoPi Dark")}</strong>
											<small>{t("Focused and low contrast")}</small>
										</span>
									</button>
									<button
										type="button"
										className={cn("theme-choice", themeState.mode === "light" && "active")}
										onClick={() => setMode("light")}
									>
										<SunIcon width={17} height={17} />
										<span>
											<strong>{t("AutoPi Light")}</strong>
											<small>{t("Clear and neutral")}</small>
										</span>
									</button>
								</div>
								<div className="settings-subsection">
									<h3>{t("Language")}</h3>
									<p className="section-description">
										{t("Choose the language used by the desktop interface.")}
									</p>
									<div className="theme-choice-row">
										<button
											type="button"
											className={cn("theme-choice", language === "zh-CN" && "active")}
											onClick={() => setLanguage("zh-CN")}
										>
											<span className="language-choice-mark">中</span>
											<span>
												<strong>{t("Chinese")}</strong>
												<small>{t("Simplified Chinese interface")}</small>
											</span>
										</button>
										<button
											type="button"
											className={cn("theme-choice", language === "en" && "active")}
											onClick={() => setLanguage("en")}
										>
											<span className="language-choice-mark">EN</span>
											<span>
												<strong>{t("English")}</strong>
												<small>{t("English interface")}</small>
											</span>
										</button>
									</div>
								</div>
							</>
						)}
						{section === "models" && (
							<ModelsProvidersPanel
								activeSession={activeSession}
								catalog={modelsProviders}
								loading={modelsLoading}
								error={modelsError}
								onRefresh={onRefreshModels}
								onSaveApiKey={onSaveProviderApiKey}
								onRemoveApiKey={onRemoveProviderApiKey}
								onLogin={onLoginProvider}
								onLogout={onLogoutProvider}
							/>
						)}
						{section === "permissions" && (
							<PermissionsPanel
								activeSession={activeSession}
								projectTrusted={projectTrusted}
								onProjectTrustChange={onProjectTrustChange}
							/>
						)}
						{section === "advanced" && (
							<>
								<h3>{t("Advanced")}</h3>
								<div className="permission-card">
									<div>
										<strong>{t("Start AutoPi at login")}</strong>
										<span>{t("Open AutoPi automatically after signing in to Windows.")}</span>
									</div>
									<button
										type="button"
										className={cn("toggle-button", settings.launchAtLogin && "active")}
										disabled={!settings.canLaunchAtLogin}
										onClick={() => onLaunchAtLoginChange(!settings.launchAtLogin)}
									>
										{settings.launchAtLogin ? t("Enabled") : t("Disabled")}
									</button>
								</div>
								<div className="settings-list">
									<Row
										label={t("Product version")}
										value={`${settings.productName} ${settings.productVersion}`}
									/>
									<Row label={t("Core CLI version")} value={settings.coreVersion} />
									<Row label={t("Build ID")} value={settings.buildId} />
									<Row label={t("Source revision")} value={settings.sourceRevision} />
									<Row
										label={t("Scheduler")}
										value={settings.scheduler === "running" ? t("Running") : settings.scheduler}
									/>
									<Row label={t("Launch directory")} value={settings.cwd} />
									<Row label={t("Automation data")} value={settings.dataDirectory} />
									<Row label={t("Agent directory")} value={settings.agentDirectory} />
									<Row label={t("Monitor adapters")} value={adapters.join(", ") || t("None")} />
								</div>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function PermissionsPanel({
	activeSession,
	projectTrusted,
	onProjectTrustChange,
}: {
	readonly activeSession: boolean;
	readonly projectTrusted: boolean;
	readonly onProjectTrustChange: (trusted: boolean) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<>
			<h3>{t("Permissions")}</h3>
			<p className="section-description">
				{t("Control whether project-scoped extensions and write-capable tools may run in this chat.")}
			</p>
			<div className="permission-card">
				<div>
					<strong>{t("Trust this workspace")}</strong>
					<span>
						{activeSession
							? t("AutoPi can use project resources and tools according to the runtime policy.")
							: t("Open a chat to change workspace permissions.")}
					</span>
				</div>
				<button
					type="button"
					className={cn("toggle-button", projectTrusted && "active")}
					disabled={!activeSession}
					onClick={() => onProjectTrustChange(!projectTrusted)}
				>
					{projectTrusted ? t("Trusted") : t("Untrusted")}
				</button>
			</div>
		</>
	);
}

function ModelsProvidersPanel({
	activeSession,
	catalog,
	loading,
	error,
	onRefresh,
	onSaveApiKey,
	onRemoveApiKey,
	onLogin,
	onLogout,
}: {
	readonly activeSession: boolean;
	readonly catalog?: DesktopModelsProviders;
	readonly loading: boolean;
	readonly error?: string;
	readonly onRefresh: () => void;
	readonly onSaveApiKey: (provider: string, apiKey: string) => Promise<void>;
	readonly onRemoveApiKey: (provider: string) => Promise<void>;
	readonly onLogin: (provider: string) => Promise<void>;
	readonly onLogout: (provider: string) => Promise<void>;
}): React.JSX.Element {
	const { t } = useI18n();
	const [expandedProvider, setExpandedProvider] = useState<string>();
	const [draftKey, setDraftKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [localError, setLocalError] = useState<string>();

	if (!activeSession) {
		return (
			<div className="capability-empty">
				<span>
					<SettingsIcon width={20} height={20} />
				</span>
				<h3>{t("Models & Providers")}</h3>
				<p>{t("Open a chat to inspect and configure the runtime attached to that session.")}</p>
			</div>
		);
	}

	async function saveKey(provider: DesktopProvider): Promise<void> {
		if (!draftKey.trim()) return;
		setSaving(true);
		setLocalError(undefined);
		try {
			await onSaveApiKey(provider.id, draftKey);
			setDraftKey("");
			setExpandedProvider(undefined);
		} catch (reason) {
			setLocalError(String(reason));
		} finally {
			setSaving(false);
		}
	}

	async function removeKey(provider: DesktopProvider): Promise<void> {
		setSaving(true);
		setLocalError(undefined);
		try {
			await onRemoveApiKey(provider.id);
		} catch (reason) {
			setLocalError(String(reason));
		} finally {
			setSaving(false);
		}
	}

	async function authenticate(provider: DesktopProvider): Promise<void> {
		setSaving(true);
		setLocalError(undefined);
		try {
			if (provider.configuredAuthType === "oauth") await onLogout(provider.id);
			else await onLogin(provider.id);
		} catch (reason) {
			setLocalError(String(reason));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<div className="provider-panel-header">
				<div>
					<h3>{t("Models & Providers")}</h3>
					<p className="section-description">
						{t("Manage credentials and inspect models available to this chat.")}
					</p>
				</div>
				<button type="button" className="quiet-button" onClick={onRefresh} disabled={loading || saving}>
					{loading ? t("Refreshing…") : t("Refresh catalog")}
				</button>
			</div>
			{(error || localError || catalog?.runtimeError) && (
				<div className="error-banner settings-model-error">{localError ?? error ?? catalog?.runtimeError}</div>
			)}
			{loading && !catalog ? (
				<div className="model-empty">{t("Loading providers…")}</div>
			) : catalog?.providers.length ? (
				<div className="provider-list">
					{catalog.providers.map((provider) => {
						const canUseApiKey = provider.auth.includes("api_key");
						const canUseOAuth = provider.auth.includes("oauth");
						const usingOAuth = provider.configuredAuthType === "oauth";
						const expanded = expandedProvider === provider.id;
						return (
							<div className="provider-card" key={provider.id}>
								<div className="provider-row">
									<span className="provider-info">
										<strong>{provider.name}</strong>
										<small>{provider.id}</small>
									</span>
									<span className={cn("provider-status", provider.configured ? "configured" : "unconfigured")}>
										{provider.configured ? t("Configured") : t("Not configured")}
									</span>
									<span className="provider-model-count">
										{t("{available}/{total} models", {
											available: provider.availableModelCount,
											total: provider.modelCount,
										})}
									</span>
									{canUseApiKey && (
										<button
											type="button"
											className="quiet-button provider-action"
											disabled={saving}
											onClick={() => {
												setExpandedProvider(expanded ? undefined : provider.id);
												setDraftKey("");
											}}
										>
											{expanded ? t("Cancel") : provider.configured ? t("Replace key") : t("Configure")}
										</button>
									)}
									{provider.configured && canUseApiKey && (
										<button
											type="button"
											className="quiet-button provider-action"
											disabled={saving}
											onClick={() => void removeKey(provider)}
										>
											{t("Remove")}
										</button>
									)}
									{canUseOAuth && (
										<button
											type="button"
											className="quiet-button provider-action"
											disabled={saving}
											onClick={() => void authenticate(provider)}
										>
											{usingOAuth ? t("Sign out") : t("Sign in")}
										</button>
									)}
								</div>
								{expanded && canUseApiKey && (
									<form
										className="provider-key-form"
										onSubmit={(event) => {
											event.preventDefault();
											void saveKey(provider);
										}}
									>
										<input
											type="password"
											value={draftKey}
											onChange={(event) => setDraftKey(event.target.value)}
											placeholder={t("Enter {provider} API key", { provider: provider.name })}
										/>
										<button type="submit" className="primary-button" disabled={!draftKey.trim() || saving}>
											{saving ? t("Saving…") : t("Save key")}
										</button>
									</form>
								)}
							</div>
						);
					})}
				</div>
			) : (
				<div className="model-empty">
					<strong>{t("No providers available")}</strong>
					<span>{t("The runtime did not expose a provider catalog for this session.")}</span>
				</div>
			)}
		</>
	);
}

function Row({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
	return (
		<div className="settings-row">
			<span>{label}</span>
			<code>{value}</code>
		</div>
	);
}
