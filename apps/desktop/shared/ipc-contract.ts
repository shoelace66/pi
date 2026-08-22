import type { JsonValue, MonitorCondition, MonitorDelivery } from "@earendil-works/pi-coding-agent";
import type {
	DeferredMessageView,
	DesktopActivity,
	DesktopExtensionUIRequest,
	DesktopExtensionUIResponse,
	DesktopFileListing,
	DesktopMode,
	DesktopModel,
	DesktopModelsProviders,
	DesktopScopedModel,
	DesktopSessionSnapshot,
	DesktopSessionStats,
	DesktopSessionTree,
	DesktopSlashCommand,
	DesktopSnapshot,
	DesktopTerminalResult,
	DesktopThinkingLevel,
	DesktopWorkspaceChanges,
	SessionListItem,
	WakeJobView,
} from "./view-models.ts";

export type SendInput = {
	sessionId: string;
	wakeId?: string;
	text: string;
	clientMessageId: string;
	imagePaths?: string[];
	deliveryMode?: "on_trigger" | "wake_now";
	streamingBehavior?: "steer" | "followUp";
};

export type CreateWakeRequest = {
	reason: string;
	objective: string;
	checkFirst: string[];
	trigger:
		| { type: "time"; dueAt: string }
		| {
				type: "monitor";
				adapter: string;
				source: Record<string, JsonValue>;
				condition: MonitorCondition;
				delivery: MonitorDelivery;
				timeout: { at: string; action: "wake" | "expire" };
		  };
};

export type RunTerminalRequest = {
	executionId: string;
	cwd: string;
	command: string;
};

export type DesktopEventPayload =
	| { type: "snapshot.changed"; snapshot: DesktopSnapshot }
	| { type: "session.message"; sessionId: string; message: DesktopSessionSnapshot["messages"][number] }
	| { type: "session.tool"; sessionId: string; tool: DesktopSessionSnapshot["toolExecutions"][number] }
	| { type: "session.status"; sessionId: string; activity: Extract<DesktopActivity, { kind: "status" }> }
	| { type: "session.settled"; sessionId: string }
	| { type: "wake.changed"; wake: WakeJobView }
	| {
			type: "notification";
			notification: {
				id: string;
				level: "info" | "success" | "warning" | "error";
				title: string;
				body: string;
				sessionId?: string;
				wakeId?: string;
			};
	  }
	| { type: "extension.ui_request"; request: DesktopExtensionUIRequest }
	| { type: "extension.ui_closed"; requestId: string };

export type DesktopEvent = DesktopEventPayload & { sequence: number };

export type DesktopApi = {
	chooseWorkspaceDirectory(): Promise<string | undefined>;
	validateWorkspaceDirectory(path: string): Promise<{ valid: boolean; path: string; name: string }>;
	getSnapshot(): Promise<DesktopSnapshot>;
	listSessions(): Promise<SessionListItem[]>;
	createSession(cwd: string): Promise<{ sessionId: string }>;
	openSession(sessionId: string): Promise<DesktopSessionSnapshot>;
	deleteSession(sessionId: string): Promise<{ nextSessionId?: string }>;
	listModels(sessionId: string): Promise<DesktopModel[]>;
	selectModel(sessionId: string, provider: string, modelId: string): Promise<DesktopModel>;
	getScopedModels(sessionId: string): Promise<DesktopScopedModel[]>;
	setScopedModels(sessionId: string, models: DesktopScopedModel[]): Promise<void>;
	getModelsProviders(sessionId: string): Promise<DesktopModelsProviders>;
	refreshModelsProviders(sessionId: string): Promise<DesktopModelsProviders>;
	setProviderApiKey(sessionId: string, provider: string, apiKey: string): Promise<DesktopModelsProviders>;
	removeProviderApiKey(sessionId: string, provider: string): Promise<DesktopModelsProviders>;
	loginProvider(sessionId: string, provider: string): Promise<DesktopModelsProviders>;
	logoutProvider(sessionId: string, provider: string): Promise<DesktopModelsProviders>;
	setProjectTrust(sessionId: string, trusted: boolean): Promise<void>;
	quit(): Promise<void>;
	listSlashCommands(sessionId: string): Promise<DesktopSlashCommand[]>;
	executeSlashCommand(sessionId: string, command: string, args?: string): Promise<{ sessionId?: string }>;
	chooseSessionFile(): Promise<string | undefined>;
	chooseImageFiles(): Promise<string[]>;
	importSession(sessionId: string, path: string): Promise<{ sessionId?: string }>;
	forkSession(sessionId: string, entryId?: string): Promise<{ sessionId?: string }>;
	cloneSession(sessionId: string): Promise<{ sessionId?: string }>;
	reloadSession(sessionId: string): Promise<void>;
	setSessionName(sessionId: string, name: string): Promise<void>;
	setSessionMode(sessionId: string, mode: DesktopMode): Promise<DesktopMode>;
	setThinkingLevel(sessionId: string, level: DesktopThinkingLevel): Promise<DesktopThinkingLevel>;
	compactSession(sessionId: string, customInstructions?: string): Promise<void>;
	getSessionStats(sessionId: string): Promise<DesktopSessionStats>;
	shareSession(sessionId: string): Promise<{ gistUrl: string; previewUrl: string }>;
	exportSession(sessionId: string, format?: "html" | "jsonl", outputPath?: string): Promise<string>;
	getSessionTree(sessionId: string): Promise<DesktopSessionTree>;
	navigateSessionTree(sessionId: string, targetId: string): Promise<{ editorText?: string; cancelled: boolean }>;
	sendInput(input: SendInput): Promise<DeferredMessageView | undefined>;
	abortSession(sessionId: string): Promise<void>;
	cancelWake(sessionId: string, wakeId: string): Promise<WakeJobView>;
	getInbox(wakeId: string): Promise<DeferredMessageView[]>;
	createWake(sessionId: string, request: CreateWakeRequest): Promise<WakeJobView>;
	listWakeups(sessionId: string, includeTerminal?: boolean): Promise<WakeJobView[]>;
	getMonitorAdapters(): Promise<string[]>;
	/** Answer a pending extension UI request. Returns false when the request already settled. */
	respondToExtensionUI(response: DesktopExtensionUIResponse): Promise<boolean>;
	getSettings(): Promise<{
		cwd: string;
		dataDirectory: string;
		agentDirectory: string;
		scheduler: "running";
		productName: string;
		productVersion: string;
		coreVersion: string;
		buildId: string;
		sourceRevision: string;
		canLaunchAtLogin: boolean;
		launchAtLogin: boolean;
	}>;
	setLaunchAtLogin(enabled: boolean): Promise<boolean>;
	setWindowTheme(theme: "dark" | "light"): Promise<void>;
	getChangelog(): Promise<string>;
	listWorkspaceFiles(path: string): Promise<DesktopFileListing>;
	getWorkspaceChanges(path: string): Promise<DesktopWorkspaceChanges>;
	runTerminalCommand(request: RunTerminalRequest): Promise<DesktopTerminalResult>;
	abortTerminalCommand(executionId: string): Promise<boolean>;
	runSessionCommand(sessionId: string, command: string, excludeFromContext?: boolean): Promise<DesktopTerminalResult>;
	openExternal(url: string): Promise<void>;
	onEvent(listener: (event: DesktopEvent) => void): () => void;
};
