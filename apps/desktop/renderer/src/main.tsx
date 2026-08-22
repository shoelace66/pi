import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { upsertDesktopActivity } from "../../shared/activity.ts";
import type { DesktopEvent } from "../../shared/ipc-contract.ts";
import { isSlashInput, parseShellInput, parseSlashInput } from "../../shared/slash.ts";
import type {
	DeferredMessageView,
	DesktopActivity,
	DesktopExtensionUIRequest,
	DesktopExtensionUIResponse,
	DesktopFileListing,
	DesktopMode,
	DesktopModel,
	DesktopModelsProviders,
	DesktopNotification,
	DesktopSessionStats,
	DesktopSessionTree,
	DesktopSnapshot,
	DesktopTerminalResult,
	DesktopThinkingLevel,
	DesktopTreeNode,
	DesktopWorkspaceChanges,
	SessionListItem,
	WakeJobView,
} from "../../shared/view-models.ts";
import { autoPiSymbolDarkUrl, autoPiSymbolLightUrl, autoPiWordmarkDarkUrl, autoPiWordmarkLightUrl } from "./brand.ts";
import { Composer, type SlashCommand, slashCommands } from "./components/composer.tsx";
import { ExtensionRequestDialog } from "./components/extension-dialog.tsx";
import { AutomationDialog, Inspector, type InspectorTab } from "./components/inspector.tsx";
import { type SettingsData, SettingsDialog } from "./components/settings.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { Timeline } from "./components/timeline.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import {
	BellIcon,
	CloseIcon,
	CodeIcon,
	FolderIcon,
	MoonIcon,
	PlusIcon,
	SparkleIcon,
	SunIcon,
	TerminalIcon,
} from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { applyTheme, loadThemeState, saveThemeState, type ThemeState } from "./theme.ts";
import { cn, loadJSON, saveJSON, workspaceName } from "./utils.ts";
import "./styles.css";

declare global {
	interface Window {
		piDesktop: import("../../shared/ipc-contract.ts").DesktopApi;
	}
}

type RecentWorkspace = { path: string; openedAt: number };
const emptySnapshot: DesktopSnapshot = { version: 1, sessions: [], updatedAt: new Date().toISOString() };
const ACTIVE_WAKE_STATUSES = new Set(["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"]);
const PINNED_KEY = "pi-desktop-pinned";
const RECENT_KEY = "pi-desktop-recent-workspaces";
const SELECTED_WORKSPACE_KEY = "pi-desktop-selected-workspace";
const SIDEBAR_KEY = "pi-desktop-sidebar-collapsed";
const TERMINAL_HEIGHT_KEY = "pi-desktop-terminal-height";
const LAST_SESSION_KEY = "autopi-last-session-by-workspace";

function App(): React.JSX.Element {
	const { t } = useI18n();
	const [snapshot, setSnapshot] = useState(emptySnapshot);
	const [workspacePath, setWorkspacePath] = useState<string>();
	const [recent, setRecent] = useState<RecentWorkspace[]>(() => loadJSON(RECENT_KEY, []));
	const [selectedId, setSelectedId] = useState<string>();
	const [draft, setDraft] = useState("");
	const [imagePaths, setImagePaths] = useState<string[]>([]);
	const [lastSubmittedText, setLastSubmittedText] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [initialized, setInitialized] = useState(false);
	const [error, setError] = useState<string>();
	const [settings, setSettings] = useState<Awaited<ReturnType<Window["piDesktop"]["getSettings"]>> | undefined>(
		undefined,
	);
	const [monitorAdapters, setMonitorAdapters] = useState<string[]>([]);
	const [themeState, setThemeState] = useState<ThemeState>(() => loadThemeState());
	const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => new Set(loadJSON<string[]>(PINNED_KEY, [])));
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadJSON(SIDEBAR_KEY, false));
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>();
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [terminalHeight, setTerminalHeight] = useState(() => loadJSON(TERMINAL_HEIGHT_KEY, 220));
	const [terminalCommand, setTerminalCommand] = useState("");
	const [terminalHistory, setTerminalHistory] = useState<DesktopTerminalResult[]>([]);
	const [terminalRunning, setTerminalRunning] = useState(false);
	const [terminalCwd, setTerminalCwd] = useState("");
	const [terminalExecutionId, setTerminalExecutionId] = useState<string>();
	const [terminalSessionId, setTerminalSessionId] = useState<string>();
	const [terminalPending, setTerminalPending] = useState<{ command: string; cwd: string }>();
	const [terminalCommandHistory, setTerminalCommandHistory] = useState<string[]>([]);
	const [workspaceFiles, setWorkspaceFiles] = useState<DesktopFileListing>();
	const [workspaceChanges, setWorkspaceChanges] = useState<DesktopWorkspaceChanges>();
	const [capabilityLoading, setCapabilityLoading] = useState(false);
	const [capabilityError, setCapabilityError] = useState<string>();
	const [showSettings, setShowSettings] = useState(false);
	const [showAutomationDialog, setShowAutomationDialog] = useState(false);
	const [showThinkingDialog, setShowThinkingDialog] = useState(false);
	const [thinkingLoading, setThinkingLoading] = useState(false);
	const [showModeDialog, setShowModeDialog] = useState(false);
	const [modeLoading, setModeLoading] = useState(false);
	const [sessionStats, setSessionStats] = useState<DesktopSessionStats>();
	const [showSessionStats, setShowSessionStats] = useState(false);
	const [sessionStatsLoading, setSessionStatsLoading] = useState(false);
	const [showChangelog, setShowChangelog] = useState(false);
	const [changelog, setChangelog] = useState("");
	const [changelogLoading, setChangelogLoading] = useState(false);
	const [showModelDialog, setShowModelDialog] = useState(false);
	const [showScopedModelsDialog, setShowScopedModelsDialog] = useState(false);
	const [scopedModelIds, setScopedModelIds] = useState<ReadonlySet<string>>(new Set());
	const [scopedModelsLoading, setScopedModelsLoading] = useState(false);
	const [scopedModelsError, setScopedModelsError] = useState<string>();
	const [modelOptions, setModelOptions] = useState<DesktopModel[]>([]);
	const [modelLoading, setModelLoading] = useState(false);
	const [modelError, setModelError] = useState<string>();
	const [modelsProviders, setModelsProviders] = useState<DesktopModelsProviders>();
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string>();
	const [showTreeDialog, setShowTreeDialog] = useState(false);
	const [sessionTree, setSessionTree] = useState<DesktopSessionTree>();
	const [treeLoading, setTreeLoading] = useState(false);
	const [treeError, setTreeError] = useState<string>();
	const [slashCatalog, setSlashCatalog] = useState<readonly SlashCommand[]>(slashCommands);
	const [extensionRequests, setExtensionRequests] = useState<DesktopExtensionUIRequest[]>([]);
	const [inbox, setInbox] = useState<Record<string, DeferredMessageView[]>>({});
	const [notifications, setNotifications] = useState<DesktopNotification[]>([]);
	const [deliveryMode] = useState<"on_trigger" | "wake_now">("on_trigger");
	const [targetWakeId, setTargetWakeId] = useState<string>();
	const timelineRef = useRef<HTMLDivElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const selectionRequestRef = useRef(0);
	const capabilityRequestRef = useRef(0);
	const terminalRequestRef = useRef(0);
	const restoredSessionRef = useRef<string | undefined>(undefined);

	const workspaceSessions = useMemo(
		() => (workspacePath ? snapshot.sessions.filter((session) => session.cwd === workspacePath) : []),
		[snapshot.sessions, workspacePath],
	);
	const knownWorkspacePaths = useMemo(
		() =>
			Array.from(new Set([...recent.map((item) => item.path), ...snapshot.sessions.map((item) => item.cwd)])).filter(
				Boolean,
			),
		[recent, snapshot.sessions],
	);
	const snapshotSession = snapshot.activeSession;
	const activeSession =
		snapshotSession && snapshotSession.cwd === workspacePath && snapshotSession.id === selectedId
			? snapshotSession
			: undefined;
	const activeJobs = useMemo(
		() => activeSession?.wakeJobs.filter((job) => ACTIVE_WAKE_STATUSES.has(job.status)) ?? [],
		[activeSession],
	);
	const deliverableJobs = useMemo(
		() => activeJobs.filter((job) => ["armed", "ready", "run_retry_wait", "blocked"].includes(job.status)),
		[activeJobs],
	);
	const isSleeping =
		deliverableJobs.length > 0 &&
		!!activeSession &&
		["sleeping", "wake_ready", "retry_wait", "blocked"].includes(activeSession.status);

	useEffect(() => {
		applyTheme(themeState);
		saveThemeState(themeState);
		void window.piDesktop?.setWindowTheme(themeState.mode);
	}, [themeState]);
	useEffect(() => {
		saveJSON(PINNED_KEY, [...pinnedIds]);
	}, [pinnedIds]);
	useEffect(() => {
		saveJSON(SIDEBAR_KEY, sidebarCollapsed);
	}, [sidebarCollapsed]);
	useEffect(() => {
		saveJSON(TERMINAL_HEIGHT_KEY, terminalHeight);
	}, [terminalHeight]);
	useEffect(() => {
		saveJSON(RECENT_KEY, recent);
	}, [recent]);
	useEffect(() => {
		if (workspacePath) localStorage.setItem(SELECTED_WORKSPACE_KEY, workspacePath);
		else localStorage.removeItem(SELECTED_WORKSPACE_KEY);
	}, [workspacePath]);
	useEffect(() => {
		setTerminalCwd(workspacePath ?? "");
		setTerminalCommand("");
		setTerminalHistory([]);
		setTerminalCommandHistory([]);
		setTerminalRunning(false);
		setTerminalExecutionId(undefined);
		setTerminalSessionId(undefined);
		setTerminalPending(undefined);
	}, [workspacePath]);
	useEffect(() => {
		if (!workspacePath || !selectedId) return;
		const current = loadJSON<Record<string, string>>(LAST_SESSION_KEY, {});
		saveJSON(LAST_SESSION_KEY, { ...current, [workspacePath]: selectedId });
	}, [selectedId, workspacePath]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Restore runs only when workspace session data changes.
	useEffect(() => {
		if (!workspacePath || selectedId) return;
		const savedId = loadJSON<Record<string, string>>(LAST_SESSION_KEY, {})[workspacePath];
		if (!savedId || !workspaceSessions.some((session) => session.id === savedId)) return;
		const restoreKey = `${workspacePath}:${savedId}`;
		if (restoredSessionRef.current === restoreKey) return;
		restoredSessionRef.current = restoreKey;
		void selectSession(savedId);
	}, [workspacePath, workspaceSessions, selectedId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: The desktop bridge subscription must be installed exactly once.
	useEffect(() => {
		const api = window.piDesktop;
		if (!api) {
			setError("AutoPi is not connected to the Electron runtime. Launch the AutoPi desktop application.");
			setInitialized(true);
			return;
		}
		let disposed = false;
		void Promise.all([api.getSnapshot(), api.getSettings(), api.getMonitorAdapters()])
			.then(async ([value, runtimeSettings, adapters]) => {
				if (disposed) return;
				setSnapshot(value);
				setSettings(runtimeSettings);
				setMonitorAdapters(adapters);
				const stored = localStorage.getItem(SELECTED_WORKSPACE_KEY);
				if (stored) {
					const validation = await api.validateWorkspaceDirectory(stored);
					if (validation.valid && !disposed) selectWorkspaceState(validation.path);
					else if (!disposed) {
						localStorage.removeItem(SELECTED_WORKSPACE_KEY);
						setError(`Workspace is no longer available: ${stored}`);
						setRecent((current) => current.filter((item) => item.path !== stored));
					}
				}
				if (!disposed) setInitialized(true);
			})
			.catch((reason) => {
				setError(String(reason));
				setInitialized(true);
			});
		const unsubscribe = api.onEvent((event: DesktopEvent) => {
			if (event.type === "snapshot.changed") setSnapshot(event.snapshot);
			if (event.type === "session.message")
				setSnapshot((current) => {
					if (current.activeSession?.id !== event.sessionId) return current;
					const messages = current.activeSession.messages.some((item) => item.id === event.message.id)
						? current.activeSession.messages.map((item) => (item.id === event.message.id ? event.message : item))
						: [...current.activeSession.messages, event.message];
					const activity: DesktopActivity = {
						kind: "message",
						id: event.message.id,
						occurredAt: new Date(event.message.timestamp ?? Date.now()).toISOString(),
						message: event.message,
					};
					return {
						...current,
						activeSession: {
							...current.activeSession,
							messages,
							activities: upsertDesktopActivity(current.activeSession.activities, activity),
							updatedAt: new Date().toISOString(),
						},
					};
				});
			if (event.type === "session.tool")
				setSnapshot((current) => {
					if (current.activeSession?.id !== event.sessionId) return current;
					const tools = current.activeSession.toolExecutions.filter((tool) => tool.id !== event.tool.id);
					const activity: DesktopActivity = {
						kind: "tool",
						id: event.tool.id,
						occurredAt: event.tool.startedAt,
						tool: event.tool,
					};
					return {
						...current,
						activeSession: {
							...current.activeSession,
							toolExecutions: [...tools, event.tool],
							activities: upsertDesktopActivity(current.activeSession.activities, activity),
							updatedAt: new Date().toISOString(),
						},
					};
				});
			if (event.type === "session.status")
				setSnapshot((current) => {
					if (current.activeSession?.id !== event.sessionId) return current;
					const status =
						event.activity.status === "run_started"
							? "running"
							: event.activity.status === "run_error"
								? "error"
								: "idle";
					return {
						...current,
						activeSession: {
							...current.activeSession,
							status,
							activities: upsertDesktopActivity(current.activeSession.activities, event.activity),
							updatedAt: new Date().toISOString(),
						},
					};
				});
			if (event.type === "notification") {
				setNotifications((current) => [...current.slice(-3), event.notification]);
				window.setTimeout(
					() => setNotifications((current) => current.filter((item) => item.id !== event.notification.id)),
					7000,
				);
			}
			if (event.type === "extension.ui_request") setExtensionRequests((current) => [...current, event.request]);
			if (event.type === "extension.ui_closed")
				setExtensionRequests((current) => current.filter((item) => item.requestId !== event.requestId));
		});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		if (activeJobs.length === 0) setTargetWakeId(undefined);
		else if (!targetWakeId || !activeJobs.some((job) => job.id === targetWakeId)) setTargetWakeId(activeJobs[0]?.id);
	}, [activeJobs, targetWakeId]);

	useEffect(() => {
		const sessionId = activeSession?.id;
		if (!sessionId || !window.piDesktop) {
			setSlashCatalog(slashCommands);
			return;
		}
		let disposed = false;
		void window.piDesktop
			.listSlashCommands(sessionId)
			.then((commands) => {
				if (disposed) return;
				setSlashCatalog([...commands, ...slashCommands.filter((command) => command.source === "desktop")]);
			})
			.catch(() => {
				if (!disposed) setSlashCatalog(slashCommands);
			});
		return () => {
			disposed = true;
		};
	}, [activeSession?.id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Shortcut handlers refresh when the selected workspace changes.
	useEffect(() => {
		function handleShortcut(event: KeyboardEvent): void {
			if (!(event.ctrlKey || event.metaKey)) return;
			if (event.key === "k") {
				event.preventDefault();
				document.querySelector<HTMLInputElement>(".sidebar-search-input")?.focus();
			}
			if (event.key === "n" && workspacePath) {
				event.preventDefault();
				void createSession();
			}
			if (event.key === ",") {
				event.preventDefault();
				openSettings();
			}
			if (event.key === "`") {
				event.preventDefault();
				setTerminalOpen((value) => !value);
			}
		}
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	}, [workspacePath]);

	function selectWorkspaceState(path: string): void {
		terminalRequestRef.current += 1;
		if (terminalExecutionId) void window.piDesktop.abortTerminalCommand(terminalExecutionId);
		if (terminalSessionId) void window.piDesktop.abortSession(terminalSessionId);
		setWorkspacePath(path);
		setSelectedId(undefined);
		setInspectorTab(undefined);
		setRecent((current) =>
			[{ path, openedAt: Date.now() }, ...current.filter((item) => item.path !== path)].slice(0, 10),
		);
	}

	async function openWorkspace(): Promise<void> {
		try {
			const path = await window.piDesktop.chooseWorkspaceDirectory();
			if (path) selectWorkspaceState(path);
		} catch (reason) {
			setError(String(reason));
		}
	}

	async function switchWorkspace(path: string): Promise<void> {
		try {
			const result = await window.piDesktop.validateWorkspaceDirectory(path);
			if (!result.valid) {
				setRecent((current) => current.filter((item) => item.path !== path));
				throw new Error(`Workspace is no longer available: ${path}`);
			}
			selectWorkspaceState(result.path);
		} catch (reason) {
			setError(String(reason));
		}
	}

	async function selectSession(id: string): Promise<void> {
		const requestId = ++selectionRequestRef.current;
		try {
			setLoading(true);
			const session = await window.piDesktop.openSession(id);
			if (requestId !== selectionRequestRef.current) return;
			setSelectedId(id);
			setSnapshot((current) => ({ ...current, activeSessionId: id, activeSession: session }));
		} catch (reason) {
			if (requestId === selectionRequestRef.current) setError(String(reason));
		} finally {
			if (requestId === selectionRequestRef.current) setLoading(false);
		}
	}

	async function createSession(): Promise<void> {
		if (!workspacePath) return;
		try {
			setLoading(true);
			const result = await window.piDesktop.createSession(workspacePath);
			await selectSession(result.sessionId);
			composerRef.current?.focus();
		} catch (reason) {
			setError(String(reason));
		} finally {
			setLoading(false);
		}
	}
	async function deleteSession(item: SessionListItem): Promise<void> {
		const label = item.name || "Untitled chat";
		if (!window.confirm(`Move “${label}” to the Recycle Bin?`)) return;
		const deletingActiveSession = selectedId === item.id;
		try {
			setLoading(true);
			const result = await window.piDesktop.deleteSession(item.id);
			setPinnedIds((current) => {
				const next = new Set(current);
				next.delete(item.id);
				return next;
			});
			if (deletingActiveSession) setSelectedId(result.nextSessionId);
			const nextSnapshot = await window.piDesktop.getSnapshot();
			setSnapshot(nextSnapshot);
			if (deletingActiveSession && result.nextSessionId) {
				setSelectedId(result.nextSessionId);
			}
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Chat moved to Recycle Bin",
					body: label,
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setLoading(false);
		}
	}

	async function refreshActiveSession(): Promise<void> {
		if (activeSession) await selectSession(activeSession.id);
	}
	async function setNameCommand(args: string): Promise<void> {
		if (!activeSession) return;
		const name = args || window.prompt("Session name", activeSession.name ?? "")?.trim() || "";
		if (!name) return;
		try {
			await window.piDesktop.setSessionName(activeSession.id, name);
			await refreshActiveSession();
			setNotifications((current) => [
				...current.slice(-3),
				{ id: crypto.randomUUID(), level: "success", title: "Session renamed", body: name },
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function exportCommand(args: string): Promise<void> {
		if (!activeSession) return;
		const format = args.toLowerCase().endsWith(".jsonl") ? "jsonl" : "html";
		try {
			const path = await window.piDesktop.exportSession(activeSession.id, format, args || undefined);
			setNotifications((current) => [
				...current.slice(-3),
				{ id: crypto.randomUUID(), level: "success", title: "Session exported", body: path },
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function reloadCommand(): Promise<void> {
		if (!activeSession) return;
		try {
			await window.piDesktop.reloadSession(activeSession.id);
			const commands = await window.piDesktop.listSlashCommands(activeSession.id);
			setSlashCatalog([...commands, ...slashCommands.filter((command) => command.source === "desktop")]);
			await refreshActiveSession();
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Resources reloaded",
					body: "Extensions, prompts, skills, and themes were refreshed.",
				},
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function copyLastAssistant(): Promise<void> {
		if (!activeSession) return;
		const message = [...activeSession.messages]
			.reverse()
			.find((item) => item.role === "assistant" && item.text.trim());
		if (!message) {
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "warning",
					title: "Nothing to copy",
					body: "This chat has no assistant response yet.",
				},
			]);
			return;
		}
		try {
			await navigator.clipboard.writeText(message.text);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Response copied",
					body: "The latest assistant response is on the clipboard.",
				},
			]);
		} catch (reason) {
			setError(`Clipboard unavailable: ${String(reason)}`);
		}
	}
	async function openCommandResult(result: { sessionId?: string }): Promise<void> {
		const sessionId = result.sessionId ?? activeSession?.id;
		if (!sessionId) return;
		const session = await window.piDesktop.openSession(sessionId);
		setSelectedId(sessionId);
		setSnapshot((current) => ({ ...current, activeSessionId: sessionId, activeSession: session }));
		const commands = await window.piDesktop.listSlashCommands(sessionId);
		setSlashCatalog([...commands, ...slashCommands.filter((item) => item.source === "desktop")]);
	}
	async function importCommand(args: string): Promise<void> {
		if (!activeSession) return;
		try {
			const path = args || (await window.piDesktop.chooseSessionFile());
			if (!path) return;
			const result = await window.piDesktop.importSession(activeSession.id, path);
			await openCommandResult(result);
			setNotifications((current) => [
				...current.slice(-3),
				{ id: crypto.randomUUID(), level: "success", title: "Session imported", body: path },
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function forkCommand(args: string): Promise<void> {
		if (!activeSession) return;
		try {
			const result = await window.piDesktop.forkSession(activeSession.id, args || undefined);
			await openCommandResult(result);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Session forked",
					body: "A new chat was created from the selected message.",
				},
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function sendChatMessage(text: string): Promise<void> {
		if (!activeSession || !text.trim() || (loading && activeSession.status !== "running")) return;
		const streaming = activeSession.status === "running";
		if (!streaming) setLoading(true);
		setLastSubmittedText(text);
		const submittedImages = imagePaths;
		setDraft("");
		setImagePaths([]);
		try {
			await window.piDesktop.sendInput({
				sessionId: activeSession.id,
				wakeId: isSleeping ? targetWakeId : undefined,
				text,
				clientMessageId: crypto.randomUUID(),
				imagePaths: submittedImages.length ? submittedImages : undefined,
				deliveryMode: isSleeping ? deliveryMode : undefined,
				streamingBehavior: streaming ? "steer" : undefined,
			});
			await refreshActiveSession();
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			setError(message);
			setDraft(text);
			setImagePaths(submittedImages);
			if (/no model selected|no api key|no configured model|no models available|model.*available/i.test(message)) {
				openSettings();
				setModelsError(message);
			}
		} finally {
			if (!streaming) setLoading(false);
		}
	}
	async function chooseImages(): Promise<void> {
		try {
			const paths = await window.piDesktop.chooseImageFiles();
			setImagePaths((current) => [...new Set([...current, ...paths])].slice(0, 5));
		} catch (reason) {
			setError(String(reason));
		}
	}
	function retryLastMessage(): void {
		if (!lastSubmittedText) return;
		setDraft(lastSubmittedText);
		window.setTimeout(() => composerRef.current?.focus(), 0);
	}
	async function cloneCommand(): Promise<void> {
		if (!activeSession) return;
		try {
			const result = await window.piDesktop.cloneSession(activeSession.id);
			await openCommandResult(result);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Session cloned",
					body: "A new chat was created at the current branch.",
				},
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function submit(): Promise<void> {
		if (
			!activeSession ||
			(!draft.trim() && imagePaths.length === 0) ||
			(loading && activeSession.status !== "running")
		)
			return;
		const text = draft.trim() || "Please review the attached image(s).";
		const shellInput = parseShellInput(text);
		if (shellInput) {
			const terminalRequestId = ++terminalRequestRef.current;
			setDraft("");
			setTerminalOpen(true);
			setTerminalRunning(true);
			setTerminalSessionId(activeSession.id);
			setTerminalPending({ command: shellInput.command, cwd: activeSession.cwd });
			setTerminalCommandHistory((current) =>
				[...current.filter((item) => item !== shellInput.command), shellInput.command].slice(-100),
			);
			try {
				const result = await window.piDesktop.runSessionCommand(
					activeSession.id,
					shellInput.command,
					shellInput.excludeFromContext,
				);
				if (terminalRequestId === terminalRequestRef.current)
					setTerminalHistory((current) => [...current.slice(-99), result]);
				await refreshActiveSession();
			} catch (reason) {
				setError(String(reason));
			} finally {
				if (terminalRequestId === terminalRequestRef.current) {
					setTerminalRunning(false);
					setTerminalSessionId(undefined);
					setTerminalPending(undefined);
				}
			}
			return;
		}
		if (text.startsWith("!")) return;
		const parsedSlash = parseSlashInput(text, slashCatalog);
		const slashCommand = parsedSlash?.command;
		if (slashCommand) {
			setDraft("");
			const args = parsedSlash.args;
			if (slashCommand.id === "name" || slashCommand.command === "/name") return void setNameCommand(args);
			if (slashCommand.id === "export" || slashCommand.command === "/export") return void exportCommand(args);
			if (slashCommand.id === "reload" || slashCommand.command === "/reload") return void reloadCommand();
			if (slashCommand.id === "copy" || slashCommand.command === "/copy") return void copyLastAssistant();
			if (slashCommand.command === "/import") return void importCommand(args);
			if (slashCommand.command === "/fork") return void forkCommand(args);
			if (slashCommand.command === "/clone") return void cloneCommand();
			if (slashCommand.command === "/compact") return void compactCommand(args);
			if (slashCommand.command === "/share") return void shareCommand();
			if (slashCommand.command === "/mode") return void handleSlashCommand(slashCommand, args);
			if (slashCommand.command === "/session") return void openSessionStats();
			if (slashCommand.source === "extension" || slashCommand.source === "prompt" || slashCommand.source === "skill")
				return void executeDynamicSlashCommand(slashCommand, args);
			if (slashCommand.source === "builtin") return handleSlashCommand(slashCommand, args);
			if (!args) return handleSlashCommand(slashCommand);
		}
		// Slash input is always a local desktop command surface. Never fall
		// through to send an unknown or incomplete command to the LLM.
		if (isSlashInput(text)) {
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "warning",
					title: "Command not found",
					body: "Choose a command from the list above. Slash commands run locally and are not sent to Pi.",
				},
			]);
			return;
		}
		if (!isSleeping && !activeSession.model) {
			try {
				const available = await window.piDesktop.listModels(activeSession.id);
				const modelMessage =
					available.length === 0
						? "No configured models are available. Add a provider API key to continue."
						: "Choose a model for this chat before sending a message.";
				openSettings();
				setModelsError(modelMessage);
			} catch (reason) {
				setError(`Unable to inspect available models: ${String(reason)}`);
			}
			return;
		}
		await sendChatMessage(text);
	}
	async function abort(): Promise<void> {
		if (!activeSession) return;
		try {
			await window.piDesktop.abortSession(activeSession.id);
			await refreshActiveSession();
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function respondToExtensionUI(response: DesktopExtensionUIResponse): Promise<void> {
		setExtensionRequests((current) => current.filter((item) => item.requestId !== response.requestId));
		try {
			await window.piDesktop.respondToExtensionUI(response);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function openInbox(job: WakeJobView): Promise<void> {
		try {
			const messages = await window.piDesktop.getInbox(job.id);
			setInbox((current) => ({ ...current, [job.id]: messages }));
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function cancelAutomation(job: WakeJobView): Promise<void> {
		if (!activeSession) return;
		try {
			await window.piDesktop.cancelWake(activeSession.id, job.id);
			await refreshActiveSession();
		} catch (reason) {
			setError(String(reason));
		}
	}

	function openSettings(): void {
		void window.piDesktop
			?.getSettings()
			.then(setSettings)
			.catch((reason) => setError(String(reason)));
		void loadModelsProviders();
		setShowSettings(true);
	}
	async function loadModelsProviders(refresh = false): Promise<void> {
		if (!activeSession) {
			setModelsProviders(undefined);
			return;
		}
		setModelsLoading(true);
		setModelsError(undefined);
		try {
			const result = refresh
				? await window.piDesktop.refreshModelsProviders(activeSession.id)
				: await window.piDesktop.getModelsProviders(activeSession.id);
			setModelsProviders(result);
		} catch (reason) {
			setModelsError(String(reason));
		} finally {
			setModelsLoading(false);
		}
	}
	async function saveProviderApiKey(provider: string, apiKey: string): Promise<void> {
		if (!activeSession) return;
		setModelsLoading(true);
		setModelsError(undefined);
		try {
			setModelsProviders(await window.piDesktop.setProviderApiKey(activeSession.id, provider, apiKey));
		} catch (reason) {
			setModelsError(String(reason));
			throw reason;
		} finally {
			setModelsLoading(false);
		}
	}
	async function removeProviderApiKey(provider: string): Promise<void> {
		if (!activeSession) return;
		setModelsLoading(true);
		setModelsError(undefined);
		try {
			setModelsProviders(await window.piDesktop.removeProviderApiKey(activeSession.id, provider));
		} catch (reason) {
			setModelsError(String(reason));
			throw reason;
		} finally {
			setModelsLoading(false);
		}
	}
	async function loginProvider(provider: string): Promise<void> {
		if (!activeSession) return;
		setModelsLoading(true);
		setModelsError(undefined);
		try {
			setModelsProviders(await window.piDesktop.loginProvider(activeSession.id, provider));
			await refreshActiveSession();
		} catch (reason) {
			setModelsError(String(reason));
			throw reason;
		} finally {
			setModelsLoading(false);
		}
	}
	async function setProjectTrust(trusted: boolean): Promise<void> {
		if (!activeSession) return;
		try {
			await window.piDesktop.setProjectTrust(activeSession.id, trusted);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: trusted ? "Project trusted" : "Project trust cleared",
					body: activeSession.cwd,
				},
			]);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function setLaunchAtLogin(enabled: boolean): Promise<void> {
		try {
			const launchAtLogin = await window.piDesktop.setLaunchAtLogin(enabled);
			setSettings((current) => (current ? { ...current, launchAtLogin } : current));
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function logoutProvider(provider: string): Promise<void> {
		if (!activeSession || !provider.trim()) return void openSettings();
		try {
			setModelsLoading(true);
			setModelsProviders(await window.piDesktop.logoutProvider(activeSession.id, provider.trim()));
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Provider logged out",
					body: provider.trim(),
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setModelsLoading(false);
		}
	}
	async function openModelDialog(): Promise<void> {
		if (!activeSession) {
			setNotifications((current) => [
				...current.slice(-3),
				{ id: crypto.randomUUID(), level: "info", title: "No active chat", body: "Open a chat to select a model." },
			]);
			return;
		}
		setShowModelDialog(true);
		setModelLoading(true);
		setModelError(undefined);
		try {
			setModelOptions(await window.piDesktop.listModels(activeSession.id));
		} catch (reason) {
			setModelError(String(reason));
		} finally {
			setModelLoading(false);
		}
	}
	async function selectModel(model: DesktopModel): Promise<void> {
		if (!activeSession) return;
		setModelLoading(true);
		setModelError(undefined);
		try {
			await window.piDesktop.selectModel(activeSession.id, model.provider, model.id);
			await refreshActiveSession();
			setShowModelDialog(false);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Model changed",
					body: `${model.provider}/${model.id}`,
				},
			]);
		} catch (reason) {
			setModelError(String(reason));
		} finally {
			setModelLoading(false);
		}
	}
	async function openScopedModelsDialog(): Promise<void> {
		if (!activeSession) return;
		setShowScopedModelsDialog(true);
		setScopedModelsLoading(true);
		setScopedModelsError(undefined);
		try {
			const [models, scoped] = await Promise.all([
				window.piDesktop.listModels(activeSession.id),
				window.piDesktop.getScopedModels(activeSession.id),
			]);
			setModelOptions(models);
			setScopedModelIds(new Set(scoped.map((entry) => `${entry.provider}/${entry.modelId}`)));
		} catch (reason) {
			setScopedModelsError(String(reason));
		} finally {
			setScopedModelsLoading(false);
		}
	}
	async function saveScopedModels(): Promise<void> {
		if (!activeSession) return;
		setScopedModelsLoading(true);
		setScopedModelsError(undefined);
		try {
			await window.piDesktop.setScopedModels(
				activeSession.id,
				modelOptions
					.filter((model) => scopedModelIds.has(`${model.provider}/${model.id}`))
					.map((model) => ({ provider: model.provider, modelId: model.id })),
			);
			setShowScopedModelsDialog(false);
		} catch (reason) {
			setScopedModelsError(String(reason));
		} finally {
			setScopedModelsLoading(false);
		}
	}
	async function selectModelReference(reference: string): Promise<void> {
		if (!activeSession || !reference.trim()) return void openModelDialog();
		const separator = reference.indexOf("/");
		if (separator <= 0 || separator === reference.length - 1) {
			setModelError("Use /model <provider>/<model> or choose a model from the selector.");
			setShowModelDialog(true);
			return;
		}
		const provider = reference.slice(0, separator).trim();
		const modelId = reference.slice(separator + 1).trim();
		setModelLoading(true);
		setModelError(undefined);
		try {
			const model = await window.piDesktop.selectModel(activeSession.id, provider, modelId);
			await refreshActiveSession();
			setShowModelDialog(false);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Model changed",
					body: `${model.provider}/${model.id}`,
				},
			]);
		} catch (reason) {
			setModelError(String(reason));
			setShowModelDialog(true);
		} finally {
			setModelLoading(false);
		}
	}
	async function setThinkingLevel(level: DesktopThinkingLevel): Promise<void> {
		if (!activeSession) return;
		setThinkingLoading(true);
		try {
			await window.piDesktop.setThinkingLevel(activeSession.id, level);
			await refreshActiveSession();
			setShowThinkingDialog(false);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setThinkingLoading(false);
		}
	}
	async function setSessionMode(mode: DesktopMode): Promise<void> {
		if (!activeSession) return;
		setModeLoading(true);
		try {
			await window.piDesktop.setSessionMode(activeSession.id, mode);
			await refreshActiveSession();
			setShowModeDialog(false);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: `${mode === "plan" ? "Plan" : "Build"} mode enabled`,
					body:
						mode === "plan"
							? "Read-only tools are active. Use Build mode when you are ready to make changes."
							: "Full tool access is active.",
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setModeLoading(false);
		}
	}
	async function compactCommand(args: string): Promise<void> {
		if (!activeSession) return;
		setLoading(true);
		try {
			await window.piDesktop.compactSession(activeSession.id, args || undefined);
			await refreshActiveSession();
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Context compacted",
					body: "The session context was summarized successfully.",
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setLoading(false);
		}
	}
	async function shareCommand(): Promise<void> {
		if (!activeSession) return;
		setLoading(true);
		try {
			const result = await window.piDesktop.shareSession(activeSession.id);
			await navigator.clipboard.writeText(result.previewUrl).catch(() => undefined);
			await window.piDesktop.openExternal(result.previewUrl);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Session shared",
					body: `${result.previewUrl} (copied to clipboard)`,
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setLoading(false);
		}
	}
	async function openSessionStats(): Promise<void> {
		if (!activeSession) return;
		setShowSessionStats(true);
		setSessionStatsLoading(true);
		try {
			setSessionStats(await window.piDesktop.getSessionStats(activeSession.id));
		} catch (reason) {
			setError(String(reason));
		} finally {
			setSessionStatsLoading(false);
		}
	}
	async function openChangelog(): Promise<void> {
		setShowChangelog(true);
		if (changelog) return;
		setChangelogLoading(true);
		try {
			setChangelog(await window.piDesktop.getChangelog());
		} catch (reason) {
			setError(String(reason));
		} finally {
			setChangelogLoading(false);
		}
	}
	async function openTreeDialog(): Promise<void> {
		if (!activeSession) {
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "info",
					title: "No active chat",
					body: "Open or create a chat before browsing its tree.",
				},
			]);
			return;
		}
		setShowTreeDialog(true);
		setTreeLoading(true);
		setTreeError(undefined);
		try {
			setSessionTree(await window.piDesktop.getSessionTree(activeSession.id));
		} catch (reason) {
			setTreeError(String(reason));
		} finally {
			setTreeLoading(false);
		}
	}
	async function executeDynamicSlashCommand(command: SlashCommand, args = ""): Promise<void> {
		if (!activeSession || !command.source || !["extension", "prompt", "skill"].includes(command.source)) return;
		setLoading(true);
		try {
			const result = await window.piDesktop.executeSlashCommand(activeSession.id, command.command.slice(1), args);
			await openCommandResult(result);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Command completed",
					body: `${command.command} ran in the current session.`,
				},
			]);
		} catch (reason) {
			setError(String(reason));
		} finally {
			setLoading(false);
		}
	}
	async function navigateTree(node: DesktopTreeNode): Promise<void> {
		if (!activeSession || node.active) return;
		setTreeLoading(true);
		setTreeError(undefined);
		try {
			const result = await window.piDesktop.navigateSessionTree(activeSession.id, node.id);
			await refreshActiveSession();
			if (result.editorText) setDraft(result.editorText);
			setShowTreeDialog(false);
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "success",
					title: "Session tree updated",
					body: result.editorText
						? "Moved to the selected message. It is ready to edit."
						: "Moved to the selected branch.",
				},
			]);
		} catch (reason) {
			setTreeError(String(reason));
		} finally {
			setTreeLoading(false);
		}
	}
	function togglePin(id: string): void {
		setPinnedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	function toggleTheme(): void {
		setThemeState((current) => ({ mode: current.mode === "dark" ? "light" : "dark" }));
	}
	function openInspector(tab: InspectorTab): void {
		setInspectorTab((current) => (current === tab ? undefined : tab));
	}
	async function refreshCapability(tab = inspectorTab): Promise<void> {
		if (!workspacePath || (tab !== "files" && tab !== "changes")) return;
		const requestId = ++capabilityRequestRef.current;
		setCapabilityLoading(true);
		setCapabilityError(undefined);
		if (tab === "files") setWorkspaceFiles(undefined);
		else setWorkspaceChanges(undefined);
		try {
			if (tab === "files") {
				const result = await window.piDesktop.listWorkspaceFiles(workspacePath);
				if (requestId === capabilityRequestRef.current) setWorkspaceFiles(result);
			} else {
				const result = await window.piDesktop.getWorkspaceChanges(workspacePath);
				if (requestId === capabilityRequestRef.current) setWorkspaceChanges(result);
			}
		} catch (reason) {
			if (requestId === capabilityRequestRef.current) setCapabilityError(String(reason));
		} finally {
			if (requestId === capabilityRequestRef.current) setCapabilityLoading(false);
		}
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh must rerun when the selected workspace or inspector tab changes.
	useEffect(() => {
		setCapabilityError(undefined);
		if (inspectorTab === "files" || inspectorTab === "changes") void refreshCapability(inspectorTab);
	}, [inspectorTab, workspacePath]);
	async function runTerminalCommand(): Promise<void> {
		if (!terminalCwd || !terminalCommand.trim() || terminalRunning) return;
		const command = terminalCommand.trim();
		if (/^(?:clear|cls)$/i.test(command)) {
			setTerminalHistory([]);
			setTerminalCommand("");
			return;
		}
		const executionId = crypto.randomUUID();
		const requestId = ++terminalRequestRef.current;
		setTerminalRunning(true);
		setTerminalExecutionId(executionId);
		setTerminalPending({ command, cwd: terminalCwd });
		setTerminalCommandHistory((current) => [...current.filter((item) => item !== command), command].slice(-100));
		try {
			const result = await window.piDesktop.runTerminalCommand({ executionId, cwd: terminalCwd, command });
			if (requestId === terminalRequestRef.current) {
				setTerminalHistory((current) => [...current.slice(-99), result]);
				setTerminalCwd(result.nextCwd);
				setTerminalCommand("");
			}
		} catch (reason) {
			setError(String(reason));
		} finally {
			if (requestId === terminalRequestRef.current) {
				setTerminalRunning(false);
				setTerminalExecutionId(undefined);
				setTerminalPending(undefined);
			}
		}
	}
	async function stopTerminalCommand(): Promise<void> {
		try {
			if (terminalExecutionId) await window.piDesktop.abortTerminalCommand(terminalExecutionId);
			else if (terminalSessionId) await window.piDesktop.abortSession(terminalSessionId);
		} catch (reason) {
			setError(String(reason));
		}
	}
	async function copyTerminalOutput(): Promise<void> {
		const content = terminalHistory
			.map((item) => `${item.cwd}> ${item.command}\n${item.stdout}${item.stderr}`.trimEnd())
			.join("\n\n");
		if (content) await navigator.clipboard.writeText(content).catch((reason) => setError(String(reason)));
	}
	function handleSlashCommand(command: SlashCommand, args = ""): void {
		setDraft("");
		const commandId = command.command.slice(1);
		if (command.argumentHint && !args) {
			setDraft(`${command.command} `);
			window.setTimeout(() => composerRef.current?.focus(), 0);
			return;
		}
		if (command.source === "extension" || command.source === "prompt" || command.source === "skill") {
			if (command.argumentHint) {
				setDraft(`${command.command} `);
				window.setTimeout(() => composerRef.current?.focus(), 0);
				return;
			}
			return void executeDynamicSlashCommand(command);
		}
		if (commandId === "new") return void createSession();
		if (commandId === "settings") return void openSettings();
		if (commandId === "mode")
			return void (args ? setSessionMode(args.toLowerCase() as DesktopMode) : setShowModeDialog(true));
		if (commandId === "model") return void (args ? selectModelReference(args) : openModelDialog());
		if (commandId === "scoped-models") return void openScopedModelsDialog();
		if (commandId === "compact") return void compactCommand(args);
		if (commandId === "share") return void shareCommand();
		if (commandId === "tree") return void openTreeDialog();
		if (commandId === "theme") return void toggleTheme();
		if (commandId === "stop") return void abort();
		if (commandId === "sessions" || commandId === "resume") {
			document.querySelector<HTMLInputElement>(".sidebar-search-input")?.focus();
			return;
		}
		if (commandId === "name") return void setNameCommand("");
		if (commandId === "copy") return void copyLastAssistant();
		if (commandId === "export") return void exportCommand("");
		if (commandId === "import") return void importCommand("");
		if (commandId === "fork") return void forkCommand("");
		if (commandId === "clone") return void cloneCommand();
		if (commandId === "reload") return void reloadCommand();
		if (commandId === "login") return void openSettings();
		if (commandId === "logout") return void logoutProvider(args);
		if (commandId === "trust") return void setProjectTrust(true);
		if (commandId === "quit") return void window.piDesktop.quit();
		if (commandId === "changelog") {
			return void openChangelog();
		}
		if (commandId === "session") return void openSessionStats();
		if (commandId === "help") {
			setDraft("/");
			window.setTimeout(() => composerRef.current?.focus(), 0);
			return;
		}
		if (commandId === "hotkeys") {
			setNotifications((current) => [
				...current.slice(-3),
				{
					id: crypto.randomUUID(),
					level: "info",
					title: "Keyboard shortcuts",
					body: "Ctrl+K search · Ctrl+N new chat · Ctrl+, settings · Ctrl+` terminal · Enter send",
				},
			]);
			return;
		}
		setNotifications((current) => [
			...current.slice(-3),
			{
				id: crypto.randomUUID(),
				level: "info",
				title: "Desktop command unavailable",
				body: `${command.command} is available in AutoPi CLI, but this Desktop action is not wired to the runtime yet.`,
			},
		]);
	}

	if (!initialized)
		return (
			<div className="splash">
				<img className="splash-symbol theme-dark-asset" src={autoPiSymbolDarkUrl} alt="" />
				<img className="splash-symbol theme-light-asset" src={autoPiSymbolLightUrl} alt="" />
				<p>{t("Opening AutoPi…")}</p>
			</div>
		);
	if (!workspacePath)
		return (
			<WorkspaceHome
				recent={recent}
				error={error}
				onDismissError={() => setError(undefined)}
				onOpen={() => void openWorkspace()}
				onSelect={(path) => void switchWorkspace(path)}
				themeMode={themeState.mode}
				onToggleTheme={toggleTheme}
			/>
		);

	const settingsData: SettingsData = settings
		? {
				cwd: settings.cwd,
				dataDirectory: settings.dataDirectory,
				agentDirectory: settings.agentDirectory,
				scheduler: settings.scheduler,
				productName: settings.productName,
				productVersion: settings.productVersion,
				coreVersion: settings.coreVersion,
				buildId: settings.buildId,
				sourceRevision: settings.sourceRevision,
				canLaunchAtLogin: settings.canLaunchAtLogin,
				launchAtLogin: settings.launchAtLogin,
			}
		: {
				cwd: t("Unavailable"),
				dataDirectory: t("Unavailable"),
				agentDirectory: t("Unavailable"),
				scheduler: t("Unavailable"),
				productName: "AutoPi",
				productVersion: t("Unavailable"),
				coreVersion: t("Unavailable"),
				buildId: t("Unavailable"),
				sourceRevision: t("Unavailable"),
				canLaunchAtLogin: false,
				launchAtLogin: false,
			};
	return (
		<div
			className={cn(
				"app-shell",
				sidebarCollapsed && "sidebar-is-collapsed",
				inspectorTab && "inspector-is-open",
				terminalOpen && "terminal-is-open",
			)}
		>
			<Sidebar
				workspacePath={workspacePath}
				workspaces={knownWorkspacePaths}
				sessions={workspaceSessions}
				selectedId={selectedId}
				pinnedIds={pinnedIds}
				loading={loading}
				collapsed={sidebarCollapsed}
				onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
				onSwitchWorkspace={(path) => void switchWorkspace(path)}
				onOpenWorkspace={() => void openWorkspace()}
				onSelect={(id) => void selectSession(id)}
				onCreate={() => void createSession()}
				onOpenSettings={openSettings}
				onTogglePin={togglePin}
				onDelete={(item) => void deleteSession(item)}
			/>
			<div className="workspace-main">
				<header className="topbar">
					<div className="topbar-context">
						<strong>{activeSession?.name || workspaceName(workspacePath)}</strong>
						<span>{activeSession ? workspaceName(workspacePath) : t("Workspace")}</span>
					</div>
					<div className="topbar-tools">
						<button
							type="button"
							className={cn("status-control", activeSession?.mode === "plan" && "mode-plan")}
							onClick={() => activeSession && setShowModeDialog(true)}
							disabled={!activeSession}
						>
							<span>{t("Mode")}</span>
							<strong>{activeSession?.mode === "plan" ? t("Plan") : t("Build")}</strong>
						</button>
						<button
							type="button"
							className="status-control"
							onClick={() => activeSession && setShowThinkingDialog(true)}
							disabled={!activeSession}
						>
							<span>{t("Thinking")}</span>
							<strong>
								{activeSession
									? t(activeSession.thinkingLevel[0].toUpperCase() + activeSession.thinkingLevel.slice(1))
									: t("Off")}
							</strong>
						</button>
						<button type="button" className="status-control model-control" onClick={() => void openModelDialog()}>
							<span>{t("Model")}</span>
							<strong>{activeSession?.model?.name ?? t("Configure model")}</strong>
						</button>
						<div className="topbar-divider" />
						<button
							type="button"
							className={cn("icon-button", inspectorTab === "runtime" && "active")}
							onClick={() => openInspector("runtime")}
							title={t("Runtime and capabilities")}
							aria-label={t("Runtime and capabilities")}
						>
							<SparkleIcon width={15} height={15} />
						</button>
						<button
							type="button"
							className={cn("icon-button", inspectorTab === "automations" && "active")}
							onClick={() => openInspector("automations")}
							title={t("Automations")}
						>
							<BellIcon width={15} height={15} />
							{activeJobs.length > 0 && <i>{activeJobs.length}</i>}
						</button>
						<button
							type="button"
							className={cn("icon-button", inspectorTab === "files" && "active")}
							onClick={() => openInspector("files")}
							title={t("Files")}
						>
							<FolderIcon width={15} height={15} />
						</button>
						<button
							type="button"
							className={cn("icon-button", inspectorTab === "changes" && "active")}
							onClick={() => openInspector("changes")}
							title={t("Changes")}
						>
							<CodeIcon width={15} height={15} />
						</button>
						<button
							type="button"
							className={cn("icon-button", terminalOpen && "active")}
							onClick={() => setTerminalOpen((value) => !value)}
							title={t("Terminal")}
						>
							<TerminalIcon width={15} height={15} />
						</button>
					</div>
				</header>
				{error && (
					<div className="error-banner">
						<span>{error}</span>
						<button type="button" onClick={() => setError(undefined)} aria-label={t("Dismiss error")}>
							<CloseIcon width={13} height={13} />
						</button>
					</div>
				)}
				<div className="chat-canvas">
					{activeSession ? (
						<>
							<Timeline
								key={activeSession.id}
								activities={activeSession.activities}
								isRunning={activeSession.status === "running"}
								timelineRef={timelineRef}
								onRetry={retryLastMessage}
								onOpenSettings={openSettings}
							/>
							<Composer
								draft={draft}
								onDraftChange={setDraft}
								onSend={() => void submit()}
								onAbort={() => void abort()}
								isRunning={activeSession.status === "running"}
								disabled={false}
								loading={loading && activeSession.status !== "running"}
								placeholder={
									isSleeping
										? t("Add instructions for the next automation run…")
										: activeSession.mode === "plan"
											? t("Describe what you want to explore…")
											: t("Message AutoPi…")
								}
								onSlashCommand={handleSlashCommand}
								composerRef={composerRef}
								commands={slashCatalog}
								imagePaths={imagePaths}
								onAttach={() => void chooseImages()}
								onRemoveImage={(path) => setImagePaths((current) => current.filter((item) => item !== path))}
							/>
						</>
					) : (
						<EmptyWorkspaceChat
							workspace={workspaceName(workspacePath)}
							hasChats={workspaceSessions.length > 0}
							onCreate={() => void createSession()}
						/>
					)}
				</div>
				{terminalOpen && (
					<TerminalPanel
						height={terminalHeight}
						onHeightChange={setTerminalHeight}
						onClose={() => setTerminalOpen(false)}
						command={terminalCommand}
						onCommandChange={setTerminalCommand}
						history={terminalHistory}
						commandHistory={terminalCommandHistory}
						cwd={terminalCwd || workspacePath || ""}
						pending={terminalPending}
						running={terminalRunning}
						onRun={() => void runTerminalCommand()}
						onStop={() => void stopTerminalCommand()}
						onClear={() => setTerminalHistory([])}
						onCopy={() => void copyTerminalOutput()}
					/>
				)}
			</div>
			{inspectorTab && (
				<Inspector
					tab={inspectorTab}
					jobs={activeSession?.wakeJobs ?? []}
					inbox={inbox}
					canCreate={!!activeSession}
					files={workspaceFiles}
					changes={workspaceChanges}
					loading={capabilityLoading}
					error={capabilityError}
					session={activeSession}
					onRefresh={() => void refreshCapability(inspectorTab)}
					onTabChange={setInspectorTab}
					onClose={() => setInspectorTab(undefined)}
					onCreate={() => setShowAutomationDialog(true)}
					onInbox={(job) => void openInbox(job)}
					onCancel={(job) => void cancelAutomation(job)}
				/>
			)}
			{showAutomationDialog && activeSession && (
				<AutomationDialog
					adapters={monitorAdapters}
					defaultCwd={activeSession.cwd}
					onClose={() => setShowAutomationDialog(false)}
					onCreated={async (request) => {
						try {
							await window.piDesktop.createWake(activeSession.id, request);
							setShowAutomationDialog(false);
							await refreshActiveSession();
						} catch (reason) {
							setError(String(reason));
						}
					}}
				/>
			)}
			{showSettings && (
				<SettingsDialog
					settings={settingsData}
					adapters={monitorAdapters}
					themeState={themeState}
					onThemeChange={setThemeState}
					onClose={() => setShowSettings(false)}
					activeSession={!!activeSession}
					projectTrusted={activeSession?.projectTrusted ?? false}
					onProjectTrustChange={(trusted) => void setProjectTrust(trusted)}
					onLaunchAtLoginChange={(enabled) => void setLaunchAtLogin(enabled)}
					modelsProviders={modelsProviders}
					modelsLoading={modelsLoading}
					modelsError={modelsError}
					onRefreshModels={() => void loadModelsProviders(true)}
					onSaveProviderApiKey={saveProviderApiKey}
					onRemoveProviderApiKey={removeProviderApiKey}
					onLoginProvider={loginProvider}
					onLogoutProvider={logoutProvider}
				/>
			)}
			{showModelDialog && activeSession && (
				<ModelDialog
					models={modelOptions}
					current={activeSession.model}
					loading={modelLoading}
					error={modelError}
					onClose={() => setShowModelDialog(false)}
					onSelect={(model) => void selectModel(model)}
				/>
			)}
			{showScopedModelsDialog && activeSession && (
				<ScopedModelsDialog
					models={modelOptions}
					selected={scopedModelIds}
					loading={scopedModelsLoading}
					error={scopedModelsError}
					onToggle={(id) =>
						setScopedModelIds((current) => {
							const next = new Set(current);
							if (next.has(id)) next.delete(id);
							else next.add(id);
							return next;
						})
					}
					onClose={() => setShowScopedModelsDialog(false)}
					onSave={() => void saveScopedModels()}
				/>
			)}
			{showTreeDialog && activeSession && (
				<TreeDialog
					tree={sessionTree}
					loading={treeLoading}
					error={treeError}
					onClose={() => setShowTreeDialog(false)}
					onSelect={(node) => void navigateTree(node)}
				/>
			)}
			{showThinkingDialog && activeSession && (
				<ThinkingDialog
					levels={activeSession.availableThinkingLevels}
					current={activeSession.thinkingLevel}
					loading={thinkingLoading}
					onClose={() => setShowThinkingDialog(false)}
					onSelect={(level) => void setThinkingLevel(level)}
				/>
			)}
			{showModeDialog && activeSession && (
				<ModeDialog
					current={activeSession.mode}
					loading={modeLoading}
					onClose={() => setShowModeDialog(false)}
					onSelect={(mode) => void setSessionMode(mode)}
				/>
			)}
			{showSessionStats && activeSession && (
				<SessionStatsDialog
					name={activeSession.name}
					stats={sessionStats}
					loading={sessionStatsLoading}
					onClose={() => setShowSessionStats(false)}
				/>
			)}
			{showChangelog && (
				<ChangelogDialog text={changelog} loading={changelogLoading} onClose={() => setShowChangelog(false)} />
			)}
			{extensionRequests[0] && (
				<ExtensionRequestDialog
					request={extensionRequests[0]}
					onRespond={(response) => void respondToExtensionUI(response)}
				/>
			)}
			<ToastStack notifications={notifications} />
		</div>
	);
}

function WorkspaceHome({
	recent,
	error,
	onDismissError,
	onOpen,
	onSelect,
	themeMode,
	onToggleTheme,
}: {
	readonly recent: readonly RecentWorkspace[];
	readonly error?: string;
	readonly onDismissError: () => void;
	readonly onOpen: () => void;
	readonly onSelect: (path: string) => void;
	readonly themeMode: ThemeState["mode"];
	readonly onToggleTheme: () => void;
}): React.JSX.Element {
	const { language, t } = useI18n();
	return (
		<div className="workspace-home">
			<header>
				<div className="brand">
					<img className="brand-symbol theme-dark-asset" src={autoPiSymbolDarkUrl} alt="" />
					<img className="brand-symbol theme-light-asset" src={autoPiSymbolLightUrl} alt="" />
					<strong>AutoPi</strong>
				</div>
				<button
					type="button"
					className="icon-button"
					onClick={onToggleTheme}
					title={themeMode === "dark" ? t("Switch to light theme") : t("Switch to dark theme")}
				>
					{themeMode === "dark" ? <SunIcon width={16} height={16} /> : <MoonIcon width={16} height={16} />}
				</button>
			</header>
			<main>
				<div className="home-hero">
					<img className="home-wordmark theme-dark-asset" src={autoPiWordmarkDarkUrl} alt="AutoPi" />
					<img className="home-wordmark theme-light-asset" src={autoPiWordmarkLightUrl} alt="AutoPi" />
					<h1>{t("Start with a workspace")}</h1>
					<p>{t("Open a folder to organize chats and let AutoPi work with the right context.")}</p>
					<button type="button" className="primary-button large" onClick={onOpen}>
						<FolderIcon width={16} height={16} /> {t("Open Folder…")}
					</button>
				</div>
				{error && (
					<div className="error-banner home-error">
						<span>{error}</span>
						<button type="button" onClick={onDismissError} aria-label={t("Dismiss error")}>
							<CloseIcon width={13} height={13} />
						</button>
					</div>
				)}
				{recent.length > 0 && (
					<section className="recent-workspaces">
						<h2>{t("Recent workspaces")}</h2>
						{recent.map((item) => (
							<button type="button" key={item.path} onClick={() => onSelect(item.path)}>
								<span className="recent-folder">
									<FolderIcon width={15} height={15} />
								</span>
								<span>
									<strong>{workspaceName(item.path)}</strong>
									<small>{item.path}</small>
								</span>
								<time>{new Date(item.openedAt).toLocaleDateString(language)}</time>
							</button>
						))}
					</section>
				)}
			</main>
		</div>
	);
}

function EmptyWorkspaceChat({
	workspace,
	hasChats,
	onCreate,
}: {
	readonly workspace: string;
	readonly hasChats: boolean;
	readonly onCreate: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="workspace-empty">
			<span className="empty-glyph">
				<SparkleIcon width={22} height={22} />
			</span>
			<h1>{hasChats ? t("Choose a chat") : t("Ready in {workspace}", { workspace })}</h1>
			<p>
				{hasChats
					? t("Select a chat from the sidebar, or start a new one.")
					: t("Create a chat when you are ready. AutoPi will use this folder as its workspace.")}
			</p>
			<button type="button" className="primary-button" onClick={onCreate}>
				<PlusIcon width={14} height={14} /> {t("New Chat")}
			</button>
		</div>
	);
}

function TerminalPanel({
	height,
	onHeightChange,
	onClose,
	command,
	onCommandChange,
	history,
	commandHistory,
	cwd,
	pending,
	running,
	onRun,
	onStop,
	onClear,
	onCopy,
}: {
	readonly height: number;
	readonly onHeightChange: (height: number) => void;
	readonly onClose: () => void;
	readonly command: string;
	readonly onCommandChange: (value: string) => void;
	readonly history: readonly DesktopTerminalResult[];
	readonly commandHistory: readonly string[];
	readonly cwd: string;
	readonly pending?: { readonly command: string; readonly cwd: string };
	readonly running: boolean;
	readonly onRun: () => void;
	readonly onStop: () => void;
	readonly onClear: () => void;
	readonly onCopy: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const outputRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [historyIndex, setHistoryIndex] = useState<number>();
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	useEffect(() => {
		const output = outputRef.current;
		if (output) output.scrollTop = output.scrollHeight;
	});
	return (
		<section className="terminal-panel" style={{ height }}>
			<button
				type="button"
				className="terminal-resize"
				aria-label={t("Resize terminal panel")}
				onPointerDown={(event) => {
					const startY = event.clientY;
					const startHeight = height;
					const move = (moveEvent: PointerEvent): void =>
						onHeightChange(Math.min(480, Math.max(140, startHeight + startY - moveEvent.clientY)));
					const up = (): void => {
						window.removeEventListener("pointermove", move);
						window.removeEventListener("pointerup", up);
					};
					window.addEventListener("pointermove", move);
					window.addEventListener("pointerup", up);
				}}
			/>
			<header>
				<div className="terminal-heading">
					<span>
						<TerminalIcon width={14} height={14} /> {t("Terminal")}
					</span>
					<code title={cwd}>{cwd}</code>
				</div>
				<div className="terminal-actions">
					{running && (
						<button type="button" className="quiet-button terminal-stop" onClick={onStop}>
							{t("Stop")}
						</button>
					)}
					<button type="button" className="quiet-button" onClick={onCopy} disabled={history.length === 0}>
						{t("Copy")}
					</button>
					<button type="button" className="quiet-button" onClick={onClear} disabled={history.length === 0}>
						{t("Clear")}
					</button>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close terminal")}>
						<CloseIcon width={13} height={13} />
					</button>
				</div>
			</header>
			<div className="terminal-output" ref={outputRef}>
				{history.length === 0 && !pending ? (
					<span className="muted">{t("Run a command in this workspace.")}</span>
				) : (
					<>
						{history.map((item) => (
							<div className="terminal-entry" key={item.executionId}>
								<div className="terminal-command">
									<span>›</span>
									<code>{item.command}</code>
									<small>
										{item.cancelled
											? t("Cancelled")
											: item.exitCode === 0
												? t("Done")
												: `exit ${item.exitCode}`}
										{" · "}
										{formatDuration(item.durationMs)}
									</small>
								</div>
								{item.stdout && <pre>{item.stdout}</pre>}
								{item.stderr && <pre className="terminal-stderr">{item.stderr}</pre>}
							</div>
						))}
						{pending && (
							<div className="terminal-entry terminal-entry-running">
								<div className="terminal-command">
									<span>›</span>
									<code>{pending.command}</code>
									<small>{t("Running…")}</small>
								</div>
							</div>
						)}
					</>
				)}
			</div>
			<form
				className="terminal-input"
				onSubmit={(event) => {
					event.preventDefault();
					onRun();
				}}
			>
				<span className="terminal-prompt" title={cwd}>
					›
				</span>
				<input
					ref={inputRef}
					value={command}
					onChange={(event) => {
						setHistoryIndex(undefined);
						onCommandChange(event.target.value);
					}}
					onKeyDown={(event) => {
						if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
						if (commandHistory.length === 0) return;
						event.preventDefault();
						if (event.key === "ArrowUp") {
							const next =
								historyIndex === undefined ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
							setHistoryIndex(next);
							onCommandChange(commandHistory[next] ?? "");
						} else if (historyIndex !== undefined && historyIndex < commandHistory.length - 1) {
							const next = historyIndex + 1;
							setHistoryIndex(next);
							onCommandChange(commandHistory[next] ?? "");
						} else {
							setHistoryIndex(undefined);
							onCommandChange("");
						}
					}}
					placeholder={t("Run a command…")}
					disabled={running}
				/>
				<button type="submit" className="quiet-button" disabled={running || !command.trim()}>
					{running ? t("Running…") : t("Run")}
				</button>
			</form>
		</section>
	);
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs} ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
	return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function ThinkingDialog({
	levels,
	current,
	loading,
	onClose,
	onSelect,
}: {
	readonly levels: readonly DesktopThinkingLevel[];
	readonly current: DesktopThinkingLevel;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly onSelect: (level: DesktopThinkingLevel) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal model-dialog" role="dialog" aria-modal="true" aria-labelledby="thinking-title">
				<header className="modal-header">
					<div>
						<h2 id="thinking-title">{t("Thinking level")}</h2>
						<p>{t("Control how much reasoning the current model uses.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				<div className="model-list">
					{levels.map((level) => (
						<button
							type="button"
							className={cn("model-option", current === level && "active")}
							key={level}
							disabled={loading}
							onClick={() => onSelect(level)}
						>
							<span className="model-option-main">
								<strong>{t(level[0].toUpperCase() + level.slice(1))}</strong>
								<small>
									{level === "off" ? t("Fastest responses") : t("More reasoning before responding")}
								</small>
							</span>
							<span className="model-option-meta">{current === level ? t("Current") : t("Select")}</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function ModeDialog({
	current,
	loading,
	onClose,
	onSelect,
}: {
	readonly current: DesktopMode;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly onSelect: (mode: DesktopMode) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const modes: ReadonlyArray<{ id: DesktopMode; title: string; description: string }> = [
		{ id: "build", title: t("Build mode"), description: t("Full tool access, including editing and writing files.") },
		{ id: "plan", title: t("Plan mode"), description: t("Read-only exploration with destructive tools disabled.") },
	];
	return (
		<div className="modal-backdrop">
			<div className="modal model-dialog" role="dialog" aria-modal="true" aria-labelledby="mode-title">
				<header className="modal-header">
					<div>
						<h2 id="mode-title">{t("Execution mode")}</h2>
						<p>{t("Choose whether Pi should explore safely or make changes.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				<div className="model-list">
					{modes.map((mode) => (
						<button
							type="button"
							className={cn("model-option", current === mode.id && "active")}
							key={mode.id}
							disabled={loading}
							onClick={() => onSelect(mode.id)}
						>
							<span className="model-option-main">
								<strong>{mode.title}</strong>
								<small>{mode.description}</small>
							</span>
							<span className="model-option-meta">{current === mode.id ? t("Current") : t("Select")}</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function SessionStatsDialog({
	name,
	stats,
	loading,
	onClose,
}: {
	readonly name?: string;
	readonly stats?: DesktopSessionStats;
	readonly loading: boolean;
	readonly onClose: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal model-dialog" role="dialog" aria-modal="true" aria-labelledby="stats-title">
				<header className="modal-header">
					<div>
						<h2 id="stats-title">{name || t("Session information")}</h2>
						<p>{t("Messages, context usage, tokens, and cost for this chat.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				{loading || !stats ? (
					<div className="model-empty">{t("Loading session statistics…")}</div>
				) : (
					<div className="settings-list session-stats-list">
						<StatRow label={t("Session ID")} value={stats.sessionId} />
						<StatRow label={t("Messages")} value={stats.totalMessages.toLocaleString()} />
						<StatRow label={t("User / assistant")} value={`${stats.userMessages} / ${stats.assistantMessages}`} />
						<StatRow label={t("Tool calls / results")} value={`${stats.toolCalls} / ${stats.toolResults}`} />
						<StatRow label={t("Input tokens")} value={stats.tokens.input.toLocaleString()} />
						<StatRow label={t("Output tokens")} value={stats.tokens.output.toLocaleString()} />
						<StatRow
							label={t("Cache read / write")}
							value={`${stats.tokens.cacheRead.toLocaleString()} / ${stats.tokens.cacheWrite.toLocaleString()}`}
						/>
						<StatRow label={t("Total tokens")} value={stats.tokens.total.toLocaleString()} />
						<StatRow label={t("Cost")} value={`$${stats.cost.toFixed(4)}`} />
						<StatRow
							label={t("Context")}
							value={
								stats.contextUsage?.percent == null
									? t("Unavailable")
									: `${stats.contextUsage.percent.toFixed(1)}% of ${stats.contextUsage.contextWindow.toLocaleString()}`
							}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

function StatRow({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
	return (
		<div className="settings-row">
			<span>{label}</span>
			<code>{value}</code>
		</div>
	);
}

function ChangelogDialog({
	text,
	loading,
	onClose,
}: {
	readonly text: string;
	readonly loading: boolean;
	readonly onClose: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal changelog-dialog" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
				<header className="modal-header">
					<div>
						<h2 id="changelog-title">{t("What's new")}</h2>
						<p>{t("Changes included with this AutoPi runtime.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				<div className="changelog-content">
					{loading ? <div className="model-empty">{t("Loading changelog…")}</div> : <Markdown text={text} />}
				</div>
			</div>
		</div>
	);
}

function ModelDialog({
	models,
	current,
	loading,
	error,
	onClose,
	onSelect,
}: {
	readonly models: readonly DesktopModel[];
	readonly current?: DesktopModel;
	readonly loading: boolean;
	readonly error?: string;
	readonly onClose: () => void;
	readonly onSelect: (model: DesktopModel) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
				<header className="modal-header">
					<div>
						<h2 id="model-dialog-title">{t("Select model")}</h2>
						<p>{t("Choose a configured runtime model for this chat.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				{loading ? (
					<div className="model-empty">{t("Loading available models…")}</div>
				) : error ? (
					<div className="error-banner model-error">{error}</div>
				) : models.length === 0 ? (
					<div className="model-empty">
						<strong>{t("No configured models")}</strong>
						<span>{t("Configure a provider in the AutoPi runtime before selecting a model.")}</span>
					</div>
				) : (
					<div className="model-list">
						{models.map((model) => {
							const selected = current?.provider === model.provider && current.id === model.id;
							return (
								<button
									type="button"
									className={cn("model-option", selected && "active")}
									key={`${model.provider}/${model.id}`}
									onClick={() => onSelect(model)}
								>
									<span className="model-option-main">
										<strong>{model.name || model.id}</strong>
										<small>
											{model.provider}/{model.id}
										</small>
									</span>
									<span className="model-option-meta">
										{selected ? t("Current") : model.reasoning ? t("Reasoning") : t("Standard")}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

function ScopedModelsDialog({
	models,
	selected,
	loading,
	error,
	onToggle,
	onClose,
	onSave,
}: {
	readonly models: readonly DesktopModel[];
	readonly selected: ReadonlySet<string>;
	readonly loading: boolean;
	readonly error?: string;
	readonly onToggle: (id: string) => void;
	readonly onClose: () => void;
	readonly onSave: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal model-dialog" role="dialog" aria-modal="true" aria-labelledby="scope-title">
				<header className="modal-header">
					<div>
						<h2 id="scope-title">{t("Model cycle scope")}</h2>
						<p>{t("Choose the models included when Pi cycles to the next model.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				{loading && models.length === 0 ? (
					<div className="model-empty">{t("Loading available models…")}</div>
				) : error ? (
					<div className="error-banner model-error">{error}</div>
				) : (
					<div className="model-list">
						{models.map((model) => {
							const id = `${model.provider}/${model.id}`;
							const enabled = selected.has(id);
							return (
								<button
									type="button"
									className={cn("model-option", enabled && "active")}
									key={id}
									disabled={loading}
									onClick={() => onToggle(id)}
								>
									<span className="model-option-main">
										<strong>{model.name || model.id}</strong>
										<small>{id}</small>
									</span>
									<span className="model-option-meta">{enabled ? t("Included") : t("Excluded")}</span>
								</button>
							);
						})}
					</div>
				)}
				<footer className="modal-actions">
					<button type="button" className="quiet-button" onClick={onClose}>
						{t("Cancel")}
					</button>
					<button type="button" className="primary-button" onClick={onSave} disabled={loading}>
						{loading ? t("Saving…") : t("Save {count} models", { count: selected.size })}
					</button>
				</footer>
			</div>
		</div>
	);
}

function TreeDialog({
	tree,
	loading,
	error,
	onClose,
	onSelect,
}: {
	readonly tree?: DesktopSessionTree;
	readonly loading: boolean;
	readonly error?: string;
	readonly onClose: () => void;
	readonly onSelect: (node: DesktopTreeNode) => void;
}): React.JSX.Element {
	const { language, t } = useI18n();
	return (
		<div className="modal-backdrop">
			<div className="modal tree-dialog" role="dialog" aria-modal="true" aria-labelledby="tree-dialog-title">
				<header className="modal-header">
					<div>
						<h2 id="tree-dialog-title">{t("Session tree")}</h2>
						<p>{t("Jump to an earlier message or branch without leaving this chat.")}</p>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")}>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				{loading ? (
					<div className="model-empty">{t("Loading session tree…")}</div>
				) : error ? (
					<div className="error-banner model-error">{error}</div>
				) : !tree || tree.nodes.length === 0 ? (
					<div className="model-empty">
						<strong>{t("No tree entries yet")}</strong>
						<span>{t("Send a message first, then use /tree to browse this chat.")}</span>
					</div>
				) : (
					<div className="tree-list">
						{tree.nodes.map((node) => (
							<button
								type="button"
								key={node.id}
								className={cn("tree-option", node.active && "active")}
								style={{ paddingLeft: `${12 + node.depth * 18}px` }}
								onClick={() => onSelect(node)}
								disabled={node.active}
								title={node.preview}
							>
								<span className="tree-option-main">
									<strong>{node.label || node.preview}</strong>
									<small>
										{node.kind.replaceAll("_", " ")} · {new Date(node.timestamp).toLocaleString(language)}
									</small>
								</span>
								<span className="tree-option-meta">
									{node.active ? t("Current") : node.hasChildren ? t("Branch") : t("Jump")}
								</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ToastStack({ notifications }: { readonly notifications: readonly DesktopNotification[] }): React.JSX.Element {
	return (
		<div className="toast-stack">
			{notifications.map((item) => (
				<div className={cn("toast", item.level)} key={item.id}>
					<strong>{item.title}</strong>
					<span>{item.body}</span>
				</div>
			))}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<I18nProvider>
			<App />
		</I18nProvider>
	</React.StrictMode>,
);
