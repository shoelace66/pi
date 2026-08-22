import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	type AgentSessionEvent,
	type CreateWakeInput,
	getAgentDir,
	getPackageDir,
	JsonlWakeJournal,
	type MonitorRegistry,
	normalizeCreateWakeInput,
	OuterLoopRuntime,
	type SessionInfo,
	SessionManager,
	type SessionStats,
	type SessionTreeNode,
	WakeRuntime,
	type WakeStore,
} from "@earendil-works/pi-coding-agent";
import { type BrowserWindow, clipboard, shell } from "electron";
import { sortDesktopActivities, upsertDesktopActivity } from "../../shared/activity.ts";
import type { DesktopApi, DesktopEventPayload, SendInput } from "../../shared/ipc-contract.ts";
import type {
	DesktopActivity,
	DesktopExtensionUIResponse,
	DesktopMessage,
	DesktopMode,
	DesktopModel,
	DesktopModelsProviders,
	DesktopProvider,
	DesktopRunPhase,
	DesktopScopedModel,
	DesktopSessionSnapshot,
	DesktopSessionStats,
	DesktopSessionStatus,
	DesktopSessionTree,
	DesktopSlashCommand,
	DesktopSnapshot,
	DesktopTerminalResult,
	DesktopThinkingLevel,
	DesktopToolExecution,
	DesktopTreeNode,
	SessionListItem,
} from "../../shared/view-models.ts";
import { DesktopWakeService } from "../services/desktop-wake-service.ts";
import {
	type ExtensionDialogRequest,
	type ExtensionDialogResponse,
	type SessionRuntime,
	SessionSupervisor,
} from "../services/session-supervisor.ts";

type DesktopControllerOptions = { window: BrowserWindow; cwd: string; dataDirectory: string };
const execFileAsync = promisify(execFile);

type RuntimeRecord = {
	file: string;
	cwd: string;
	name?: string;
	preview?: string;
	messageCount: number;
	tools: Map<string, DesktopToolExecution>;
	activities: DesktopActivity[];
	updatedAt: string;
	runError?: string;
	currentRunActivityId?: string;
	currentRunStatusKey?: string;
	currentRunSettled?: boolean;
};

type PendingUIRequest = {
	sessionId: string;
	settle: (response: ExtensionDialogResponse) => void;
	cleanup: () => void;
};

type ModelSnapshot = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
};

type TreeEntrySnapshot = {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	message?: unknown;
	summary?: string;
	customType?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

const DESKTOP_BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "mode", description: "Switch between Build and Plan mode", argumentHint: "<build|plan>" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit AutoPi" },
];

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as {
		role?: string;
		content?: unknown;
		errorMessage?: unknown;
		command?: unknown;
		output?: unknown;
		exitCode?: unknown;
	};
	if (value.role === "bashExecution" && typeof value.command === "string") {
		const output = typeof value.output === "string" ? value.output : "";
		const exit = typeof value.exitCode === "number" ? `\n[exit ${value.exitCode}]` : "";
		return `$ ${value.command}${output ? `\n${output}` : ""}${exit}`;
	}
	if (typeof value.content === "string") return value.content;
	if (Array.isArray(value.content))
		return value.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					!!part &&
					typeof part === "object" &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("");
	if (typeof value.errorMessage === "string" && value.errorMessage.trim())
		return `Error: ${value.errorMessage.trim()}`;
	return "";
}

function messageThinking(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const thinking = content
		.filter(
			(part): part is { type: "thinking"; thinking: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking" &&
				typeof (part as { thinking?: unknown }).thinking === "string",
		)
		.map((part) => part.thinking)
		.join("\n\n")
		.trim();
	return thinking || undefined;
}

function messageError(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as { errorMessage?: unknown };
	return typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage.trim() : undefined;
}

function readableError(reason: unknown): string {
	if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
	if (typeof reason === "string" && reason.trim()) return reason.trim();
	try {
		return JSON.stringify(reason);
	} catch {
		return String(reason);
	}
}

function imageMimeType(path: string): "image/png" | "image/jpeg" | "image/webp" {
	const extension = extname(path).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".webp") return "image/webp";
	if (extension === ".png") return "image/png";
	throw new Error(`Unsupported image type: ${extension || path}`);
}

export class DesktopController {
	private readonly options: DesktopControllerOptions;
	private readonly sessions: SessionSupervisor;
	private readonly runtimes = new Map<string, RuntimeRecord>();
	private readonly wakeStore: WakeStore;
	private readonly wakeService: DesktopWakeService;
	private readonly monitorRegistry: MonitorRegistry;
	private readonly wakeRuntime: WakeRuntime;
	private readonly outerLoopRuntime: OuterLoopRuntime;
	private disposed = false;
	private snapshotQueue: Promise<void> = Promise.resolve();
	private snapshotPending = false;
	private snapshotLoopRunning = false;
	private readonly knownWakeStates = new Map<string, string>();
	private readonly extensionErrors = new Map<string, string>();
	private readonly pendingUIRequests = new Map<string, PendingUIRequest>();
	private discovered = false;
	private sequence = 0;
	private activeSessionId?: string;
	private activeSessionRevision = 0;

	constructor(options: DesktopControllerOptions) {
		this.options = options;
		const wakeJournal = new JsonlWakeJournal({ filePath: join(options.dataDirectory, "wake-events.jsonl") });
		this.wakeRuntime = new WakeRuntime({ agentDir: getAgentDir(), journal: wakeJournal });
		this.outerLoopRuntime = new OuterLoopRuntime({
			cwd: options.cwd,
			wakeRuntime: this.wakeRuntime,
			stopWakeRuntime: true,
			checkIntervalMs: 5_000,
			journal: wakeJournal,
		});
		this.wakeStore = this.outerLoopRuntime.store;
		this.monitorRegistry = this.outerLoopRuntime.monitorRegistry;
		this.sessions = new SessionSupervisor({
			wakeRuntime: this.wakeRuntime,
			outerLoopRuntime: this.outerLoopRuntime,
			onExtensionNotification: (sessionFile, message, type) => {
				this.emit({
					type: "notification",
					notification: {
						id: randomUUID(),
						level: type,
						title: "Extension notification",
						body: message,
						sessionId: this.sessionIdForFile(sessionFile),
					},
				});
			},
			onExtensionError: (sessionFile, error) => {
				this.extensionErrors.set(sessionFile, `${error.extensionPath}: ${error.error}`);
				this.emit({
					type: "notification",
					notification: {
						id: randomUUID(),
						level: "error",
						title: "Extension command failed",
						body: `${error.extensionPath}: ${error.error}`,
						sessionId: this.sessionIdForFile(sessionFile),
					},
				});
			},
			onExtensionUIDialog: (sessionFile, request, options) => this.extensionUIDialog(sessionFile, request, options),
			onSessionReplaced: (sessionFile, nextSessionFile, cwd, nextSessionId) => {
				const currentEntry = [...this.runtimes.entries()].find(([, item]) => item.file === sessionFile);
				const record = currentEntry?.[1];
				if (!record) return;
				if (currentEntry && currentEntry[0] !== nextSessionId) this.runtimes.delete(currentEntry[0]);
				record.file = nextSessionFile;
				record.cwd = cwd;
				record.name = undefined;
				record.tools.clear();
				record.activities = [];
				record.updatedAt = new Date().toISOString();
				record.runError = undefined;
				record.currentRunActivityId = undefined;
				record.currentRunStatusKey = undefined;
				record.currentRunSettled = undefined;
				this.runtimes.set(nextSessionId, record);
				if (this.activeSessionId === currentEntry?.[0]) this.activateSession(nextSessionId);
				void this.emitSnapshot();
			},
		});
		this.wakeService = new DesktopWakeService(this.wakeStore);
		this.outerLoopRuntime.subscribe((event) => {
			if (event.type === "wake_started") this.wakeService.markDelivering(event.job.id);
			if (event.type === "wake_finished") this.wakeService.markDelivered(event.job.id);
			void this.emitSnapshot();
		});
		this.outerLoopRuntime.start();
	}

	private sessionIdForFile(sessionFile: string): string | undefined {
		for (const [id, record] of this.runtimes) if (record.file === sessionFile) return id;
		return undefined;
	}

	private activateSession(sessionId: string): void {
		if (this.activeSessionId === sessionId) return;
		this.activeSessionId = sessionId;
		this.activeSessionRevision++;
	}

	private deactivateSession(): void {
		if (!this.activeSessionId) return;
		this.activeSessionId = undefined;
		this.activeSessionRevision++;
	}

	private async discoverSessions(): Promise<void> {
		if (this.discovered) return;
		const sessions = await SessionManager.listAll();
		for (const info of sessions) this.addSessionInfo(info);
		this.discovered = true;
	}

	private addSessionInfo(info: SessionInfo): void {
		if (!info.path || !info.cwd || this.runtimes.has(info.id)) return;
		this.runtimes.set(info.id, {
			file: info.path,
			cwd: info.cwd,
			name: info.name,
			preview: info.firstMessage,
			messageCount: info.messageCount,
			tools: new Map(),
			activities: [],
			updatedAt: info.modified.toISOString(),
		});
	}

	private emit(event: DesktopEventPayload): void {
		if (this.disposed || this.options.window.isDestroyed()) return;
		this.options.window.webContents.send("desktop:event", { ...event, sequence: ++this.sequence });
	}

	/** Bridge an extension dialog to the renderer modal via a requestId correlation. */
	private extensionUIDialog(
		sessionFile: string,
		request: ExtensionDialogRequest,
		options: { signal: AbortSignal; timeout?: number },
	): Promise<ExtensionDialogResponse> {
		const sessionId = this.sessionIdForFile(sessionFile);
		if (!sessionId) return Promise.resolve({ outcome: "cancelled" });
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const onAbort = (): void => this.settleUIRequest(requestId, { outcome: "cancelled" }, true);
			this.pendingUIRequests.set(requestId, {
				sessionId,
				settle: resolve,
				cleanup: () => options.signal.removeEventListener("abort", onAbort),
			});
			options.signal.addEventListener("abort", onAbort, { once: true });
			this.emit({
				type: "extension.ui_request",
				request: { ...request, requestId, sessionId, timeout: options.timeout },
			});
		});
	}

	/**
	 * Settle a pending UI request. `notifyRenderer` tells the renderer to close a
	 * modal it may still show (timeout, abort, replacement); renderer-answered
	 * requests already closed their modal locally.
	 */
	private settleUIRequest(requestId: string, response: ExtensionDialogResponse, notifyRenderer: boolean): void {
		const pending = this.pendingUIRequests.get(requestId);
		if (!pending) return;
		this.pendingUIRequests.delete(requestId);
		pending.cleanup();
		pending.settle(response);
		if (notifyRenderer) this.emit({ type: "extension.ui_closed", requestId });
	}

	/** Answer a pending extension UI request from the renderer. */
	respondToExtensionUI(response: DesktopExtensionUIResponse): boolean {
		if (!this.pendingUIRequests.has(response.requestId)) return false;
		const dialogResponse: ExtensionDialogResponse =
			response.outcome === "cancelled"
				? { outcome: "cancelled" }
				: response.outcome === "confirmed"
					? { outcome: "confirmed", value: response.value }
					: { outcome: response.outcome, value: response.value };
		this.settleUIRequest(response.requestId, dialogResponse, false);
		return true;
	}

	private messageView(
		message: {
			role: string;
			content?: unknown;
			customType?: string;
			details?: unknown;
			timestamp?: number;
		},
		id: string = randomUUID(),
	): DesktopMessage {
		const role =
			message.role === "assistant" || message.role === "user" || message.role === "custom" ? message.role : "tool";
		return {
			id,
			role,
			customType: message.customType,
			text: messageText(message),
			thinking: messageThinking(message),
			details: message.details,
			timestamp: message.timestamp,
		};
	}

	private messageIdentity(message: { role?: string; timestamp?: number }, index?: number): string {
		return `message:${message.role ?? "unknown"}:${message.timestamp ?? index ?? "live"}`;
	}

	private modelView(model: ModelSnapshot): DesktopModel {
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
	}

	private treePreview(entry: TreeEntrySnapshot): string {
		if (entry.type === "message") {
			const text = messageText(entry.message).trim();
			if (text) return text;
			const role =
				entry.message && typeof entry.message === "object" ? (entry.message as { role?: unknown }).role : undefined;
			return typeof role === "string" ? role : "Message";
		}
		if (entry.type === "branch_summary" || entry.type === "compaction") return entry.summary?.trim() || entry.type;
		if (entry.type === "model_change") return `${entry.provider ?? ""}/${entry.modelId ?? ""}`.replace(/^\//, "");
		if (entry.type === "session_info") return entry.name?.trim() || "Session renamed";
		if (entry.type === "custom_message" || entry.type === "custom") return entry.customType || "Custom event";
		if (entry.type === "thinking_level_change") return entry.thinkingLevel || "Thinking level changed";
		return entry.type.replaceAll("_", " ");
	}

	private flattenTree(nodes: SessionTreeNode[], leafId: string | null, depth = 0): DesktopTreeNode[] {
		const result: DesktopTreeNode[] = [];
		for (const node of nodes) {
			const entry = node.entry as unknown as TreeEntrySnapshot;
			result.push({
				id: entry.id,
				parentId: entry.parentId,
				kind: entry.type,
				label: node.label,
				preview: this.treePreview(entry),
				timestamp: entry.timestamp ?? new Date().toISOString(),
				depth,
				hasChildren: node.children.length > 0,
				active: entry.id === leafId,
			});
			result.push(...this.flattenTree(node.children, leafId, depth + 1));
		}
		return result;
	}

	private async sessionRuntime(sessionId: string): Promise<{ record: RuntimeRecord; runtime: SessionRuntime }> {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? sessionId, event),
			));
		return { record, runtime };
	}

	private async modelsProvidersView(runtime: SessionRuntime): Promise<DesktopModelsProviders> {
		const modelRuntime = runtime.session.modelRuntime;
		const available = modelRuntime.getAvailableSnapshot();
		const all = modelRuntime.getModels();
		const providers: DesktopProvider[] = await Promise.all(
			modelRuntime.getProviders().map(async (provider) => {
				const auth = await modelRuntime.checkAuth(provider.id).catch(() => undefined);
				const authModes: Array<"api_key" | "oauth"> = [];
				const providerAuth = provider.auth as { apiKey?: unknown; oauth?: unknown };
				if (providerAuth.apiKey) authModes.push("api_key");
				if (providerAuth.oauth) authModes.push("oauth");
				return {
					id: provider.id,
					name: provider.name,
					auth: authModes,
					configured: !!auth,
					configuredAuthType: auth ? (modelRuntime.isUsingOAuth(provider.id) ? "oauth" : "api_key") : undefined,
					authSource: auth?.source,
					modelCount: all.filter((model) => model.provider === provider.id).length,
					availableModelCount: available.filter((model) => model.provider === provider.id).length,
				};
			}),
		);
		return {
			providers: providers.sort(
				(left, right) => Number(right.configured) - Number(left.configured) || left.name.localeCompare(right.name),
			),
			models: available.map((model) => this.modelView(model)),
			runtimeError: modelRuntime.getError(),
		};
	}

	private recordStatus(
		sessionId: string,
		status: Extract<DesktopActivity, { kind: "status" }>["status"],
		message?: string,
		rawError?: string,
		options?: { phase?: DesktopRunPhase; statusKey?: string; startNew?: boolean },
	): void {
		const record = this.runtimes.get(sessionId);
		if (!record) return;
		if (status === "run_started" && !options?.startNew && record.currentRunStatusKey === options?.statusKey) return;
		if (options?.startNew || !record.currentRunActivityId) record.currentRunActivityId = randomUUID();
		const now = new Date().toISOString();
		record.updatedAt = now;
		const activity: Extract<DesktopActivity, { kind: "status" }> = {
			kind: "status",
			id: record.currentRunActivityId,
			occurredAt: now,
			status,
			phase: options?.phase,
			message,
			rawError,
			retryable: status === "run_error",
		};
		record.activities = upsertDesktopActivity(record.activities, activity);
		record.currentRunStatusKey = options?.statusKey;
		if (status === "run_error") record.runError = message;
		if (status === "run_started") {
			record.runError = undefined;
			record.currentRunSettled = false;
		} else {
			record.currentRunSettled = true;
		}
		this.emit({ type: "session.status", sessionId, activity });
	}

	private updateRunPhase(sessionId: string, phase: DesktopRunPhase, statusKey: string, message: string): void {
		const record = this.runtimes.get(sessionId);
		if (!record) return;
		this.recordStatus(sessionId, "run_started", message, undefined, {
			phase,
			statusKey,
			startNew: !record.currentRunActivityId || record.currentRunSettled,
		});
	}

	private updateToolRunPhase(sessionId: string, record: RuntimeRecord, finishedToolName?: string): void {
		const runningTools = [...record.tools.values()]
			.filter((tool) => tool.status === "running")
			.map((tool) => tool.toolName);
		if (runningTools.length > 0) {
			const uniqueTools = [...new Set(runningTools)];
			const label = uniqueTools.join(", ");
			this.updateRunPhase(
				sessionId,
				"tool",
				`tools:${label}`,
				`${uniqueTools.length === 1 ? "Running tool" : "Running tools"}: ${label}`,
			);
			return;
		}
		if (finishedToolName)
			this.updateRunPhase(
				sessionId,
				"reviewing",
				`reviewing:${finishedToolName}`,
				`Reviewing the result from ${finishedToolName}`,
			);
	}

	private runErrorFromMessages(messages: readonly unknown[]): string | undefined {
		for (const message of messages) {
			const error = messageError(message);
			if (error) return error;
		}
		return undefined;
	}

	private async sessionSnapshot(sessionId: string): Promise<DesktopSessionSnapshot> {
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? sessionId, event),
			));
		const jobs = await this.wakeService.list(sessionId, true);
		const messages: DesktopMessage[] = runtime.session.messages.map((message, index) =>
			this.messageView(message, this.messageIdentity(message, index)),
		);
		const activities: DesktopActivity[] = [
			...messages.map((message, index) => ({
				kind: "message" as const,
				id: message.id,
				occurredAt: new Date(message.timestamp ?? index).toISOString(),
				message,
			})),
			...[...record.tools.values()].map((tool) => ({
				kind: "tool" as const,
				id: tool.id,
				occurredAt: tool.startedAt,
				tool,
			})),
			...record.activities,
		];
		const status: DesktopSessionStatus = runtime.session.isStreaming
			? "running"
			: jobs.some((job) => job.status === "blocked")
				? "blocked"
				: jobs.some((job) => job.status === "ready")
					? "wake_ready"
					: jobs.some((job) => job.status === "run_retry_wait")
						? "retry_wait"
						: jobs.some((job) => job.status === "armed")
							? "sleeping"
							: "idle";
		record.name = runtime.session.sessionName ?? record.name;
		return {
			id: sessionId,
			name: record.name,
			cwd: record.cwd,
			sessionFile: record.file,
			status,
			messages,
			toolExecutions: [...record.tools.values()],
			activities: sortDesktopActivities(activities),
			model: runtime.session.model ? this.modelView(runtime.session.model) : undefined,
			mode: this.sessionMode(runtime.session),
			thinkingLevel: runtime.session.thinkingLevel as DesktopThinkingLevel,
			availableThinkingLevels: runtime.session.getAvailableThinkingLevels() as DesktopThinkingLevel[],
			queue: {
				steering: [...runtime.session.getSteeringMessages()],
				followUp: [...runtime.session.getFollowUpMessages()],
			},
			isCompacting: runtime.session.isCompacting,
			contextUsage: runtime.session.getContextUsage(),
			projectTrusted: runtime.session.settingsManager.isProjectTrusted(),
			wakeJobs: jobs,
			runtime: {
				outerLoopEnabled: true,
				scheduler: "running",
				monitorAdapters: this.monitorRegistry.list().map((adapter) => adapter.name),
				activeTools: runtime.session.getActiveToolNames(),
				extensionCommands: runtime.session.extensionRunner
					.getRegisteredCommands()
					.map((command) => command.invocationName),
				promptTemplates: runtime.session.promptTemplates.map((prompt) => prompt.name),
				skills: runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name),
			},
			updatedAt: record.updatedAt,
		};
	}

	private sessionMode(session: SessionRuntime["session"]): DesktopMode {
		// Build is the CLI's normal/full-tool mode. The plan extension deliberately
		// removes edit/write while it is enabled, so this remains compatible with
		// the extension's persisted state without duplicating its implementation.
		const hasPlanCommand = !!session.extensionRunner.getCommand("plan");
		const activeTools = new Set(session.getActiveToolNames());
		return hasPlanCommand && !activeTools.has("edit") && !activeTools.has("write") ? "plan" : "build";
	}

	private async sessionListItem(id: string, record: RuntimeRecord): Promise<SessionListItem> {
		const jobs = await this.wakeService.list(id);
		const runtime = this.sessions.get(record.file);
		const status: DesktopSessionStatus = runtime?.session.isStreaming
			? "running"
			: jobs.some((job) => job.status === "blocked")
				? "blocked"
				: jobs.some((job) => job.status === "ready")
					? "wake_ready"
					: jobs.some((job) => job.status === "run_retry_wait")
						? "retry_wait"
						: jobs.some((job) => job.status === "armed")
							? "sleeping"
							: "idle";
		return {
			id,
			name: runtime?.session.sessionName ?? record.name,
			cwd: record.cwd,
			status,
			updatedAt: record.updatedAt,
			wakeCount: jobs.length,
			messageCount: runtime?.session.messages.length ?? record.messageCount,
			preview:
				runtime?.session.messages.map((message) => messageText(message).trim()).find(Boolean) ?? record.preview,
		};
	}

	private onAgentEvent(sessionId: string, event: AgentSessionEvent): void {
		const record = this.runtimes.get(sessionId);
		if (!record) return;
		record.updatedAt = new Date().toISOString();
		if (event.type === "agent_start")
			this.updateRunPhase(
				sessionId,
				"preparing",
				"preparing",
				"Preparing the model request and conversation context",
			);
		if (event.type === "turn_start") {
			const model = this.sessions.get(record.file)?.session.model;
			const modelName = model?.name || model?.id || "the selected model";
			this.updateRunPhase(sessionId, "reasoning", "reasoning", `Waiting for ${modelName} to produce the next step`);
		}
		if (event.type === "compaction_start") {
			const reason = event.reason === "manual" ? "requested manually" : `triggered by ${event.reason}`;
			this.updateRunPhase(
				sessionId,
				"compacting",
				`compacting:${event.reason}`,
				`Summarizing older context (${reason})`,
			);
		}
		if (event.type === "compaction_end" && !event.aborted && event.result)
			this.updateRunPhase(
				sessionId,
				"reasoning",
				"reasoning-after-compaction",
				"Context compacted; resuming the model request",
			);
		if (event.type === "auto_retry_start")
			this.updateRunPhase(
				sessionId,
				"retrying",
				`retry:${event.attempt}`,
				`Retrying after an API error (attempt ${event.attempt}/${event.maxAttempts}, in ${Math.ceil(event.delayMs / 1_000)} s)`,
			);
		if (event.type === "summarization_retry_scheduled")
			this.updateRunPhase(
				sessionId,
				"retrying",
				`summary-retry:${event.attempt}`,
				`Retrying context summary (attempt ${event.attempt}/${event.maxAttempts}, in ${Math.ceil(event.delayMs / 1_000)} s)`,
			);
		if (event.type === "agent_end" && !event.willRetry) {
			const error = this.runErrorFromMessages(event.messages);
			if (error) this.recordStatus(sessionId, "run_error", error, error);
			else this.updateRunPhase(sessionId, "finalizing", "finalizing", "Finalizing the response and session state");
		}
		if (event.type === "message_update" || event.type === "message_end") {
			const message = this.messageView(event.message, this.messageIdentity(event.message));
			this.emit({
				type: "session.message",
				sessionId,
				message,
			});
			if (event.message.role === "assistant") {
				if (message.text)
					this.updateRunPhase(sessionId, "responding", "responding", "Streaming the answer into the conversation");
				else if (message.thinking)
					this.updateRunPhase(
						sessionId,
						"reasoning",
						"reasoning-stream",
						"The model is reasoning about the request",
					);
			}
		}
		if (event.type === "tool_execution_start") {
			const now = new Date().toISOString();
			const tool: DesktopToolExecution = {
				id: event.toolCallId,
				toolName: event.toolName,
				status: "running",
				args: event.args,
				startedAt: now,
				updatedAt: now,
			};
			record.tools.set(tool.id, tool);
			this.emit({ type: "session.tool", sessionId, tool });
			this.updateToolRunPhase(sessionId, record);
		}
		if (event.type === "tool_execution_update") {
			const current = record.tools.get(event.toolCallId) ?? {
				id: event.toolCallId,
				toolName: event.toolName,
				status: "running" as const,
				args: event.args,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const tool: DesktopToolExecution = {
				...current,
				args: event.args,
				partialResult: event.partialResult,
				updatedAt: new Date().toISOString(),
			};
			record.tools.set(tool.id, tool);
			this.emit({ type: "session.tool", sessionId, tool });
			this.updateToolRunPhase(sessionId, record);
		}
		if (event.type === "tool_execution_end") {
			const current = record.tools.get(event.toolCallId);
			const tool: DesktopToolExecution = {
				...(current ?? { id: event.toolCallId, toolName: event.toolName, startedAt: new Date().toISOString() }),
				toolName: event.toolName,
				status: event.isError ? "error" : "completed",
				result: event.result,
				isError: event.isError,
				updatedAt: new Date().toISOString(),
			};
			record.tools.set(tool.id, tool);
			this.emit({ type: "session.tool", sessionId, tool });
			this.updateToolRunPhase(sessionId, record, event.toolName);
		}
		if (event.type === "agent_settled") {
			if (!record.runError) this.recordStatus(sessionId, "run_completed", "Response complete");
			this.emit({ type: "session.settled", sessionId });
		}
		// Message/tool events are forwarded incrementally above. Serializing the
		// complete session history for every streamed token scales with chat length
		// and can starve the renderer on long conversations.
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
			void this.emitSnapshot();
		}
	}

	private async emitSnapshot(): Promise<void> {
		// Streaming responses can emit dozens of message/tool updates per second.
		// Coalesce those invalidations so a slow full snapshot never creates an
		// unbounded FIFO backlog that makes the renderer appear frozen.
		this.snapshotPending = true;
		if (!this.snapshotLoopRunning) {
			this.snapshotLoopRunning = true;
			this.snapshotQueue = this.snapshotQueue
				.catch(() => undefined)
				.then(async () => {
					while (this.snapshotPending) {
						this.snapshotPending = false;
						const snapshot = await this.snapshot();
						await this.emitWakeNotifications(snapshot);
						this.emit({ type: "snapshot.changed", snapshot });
					}
				})
				.finally(() => {
					this.snapshotLoopRunning = false;
				});
		}
		await this.snapshotQueue;
	}

	private async emitWakeNotifications(snapshot: DesktopSnapshot): Promise<void> {
		for (const session of snapshot.sessions) {
			const jobs = await this.wakeService.list(session.id, true);
			for (const job of jobs) {
				const previous = this.knownWakeStates.get(job.id);
				this.knownWakeStates.set(job.id, job.status);
				if (!previous || previous === job.status) continue;
				const notification =
					job.status === "ready"
						? { level: "info" as const, title: "Automation is ready", body: job.reason }
						: job.status === "completed"
							? { level: "success" as const, title: "Automation completed", body: job.reason }
							: job.status === "blocked" || job.status === "dead_letter"
								? {
										level: "error" as const,
										title: "Automation needs attention",
										body: job.error?.message ?? job.reason,
									}
								: undefined;
				if (notification)
					this.emit({
						type: "notification",
						notification: { ...notification, id: randomUUID(), sessionId: session.id, wakeId: job.id },
					});
			}
		}
	}

	async snapshot(): Promise<DesktopSnapshot> {
		const activeSessionRevision = this.activeSessionRevision;
		await this.discoverSessions();
		const sessions: SessionListItem[] = [];
		for (const [id, record] of this.runtimes) {
			sessions.push(await this.sessionListItem(id, record));
		}
		sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		const activeSessionId = this.activeSessionId;
		const snapshot: DesktopSnapshot = {
			version: 1,
			activeSessionId,
			sessions,
			activeSession: activeSessionId ? await this.sessionSnapshot(activeSessionId) : undefined,
			updatedAt: new Date().toISOString(),
		};
		// A session switch may complete while an older full snapshot is being
		// assembled. Never publish that stale snapshot over the newly selected chat.
		if (activeSessionRevision !== this.activeSessionRevision) return this.snapshot();
		return snapshot;
	}

	async listSessions(): Promise<SessionListItem[]> {
		return (await this.snapshot()).sessions;
	}

	async createSession(cwd: string): Promise<{ sessionId: string }> {
		let sessionId: string | undefined;
		const runtime = await this.sessions.create(cwd, (event) => {
			if (sessionId) this.onAgentEvent(sessionId, event);
		});
		sessionId = runtime.session.sessionId;
		this.runtimes.set(sessionId, {
			file: runtime.file!,
			cwd,
			name: runtime.session.sessionName,
			messageCount: 0,
			tools: new Map(),
			activities: [],
			updatedAt: new Date().toISOString(),
		});
		this.activateSession(sessionId);
		return { sessionId };
	}

	async openSession(sessionId: string): Promise<DesktopSessionSnapshot> {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const snapshot = await this.sessionSnapshot(sessionId);
		this.activateSession(sessionId);
		return snapshot;
	}

	async deleteSession(sessionId: string): Promise<{ nextSessionId?: string }> {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const runtime = this.sessions.get(record.file);
		if (runtime?.session.isStreaming) throw new Error("Stop the running response before deleting this chat");
		await this.sessions.close(record.file);
		await shell.trashItem(record.file);
		this.runtimes.delete(sessionId);

		let nextSessionId: string | undefined;
		if (this.activeSessionId === sessionId) {
			nextSessionId = [...this.runtimes.entries()]
				.filter(([, candidate]) => candidate.cwd === record.cwd)
				.sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))[0]?.[0];
			if (nextSessionId) this.activateSession(nextSessionId);
			else this.deactivateSession();
		}
		await this.emitSnapshot();
		return { nextSessionId };
	}

	async listModels(sessionId: string): Promise<DesktopModel[]> {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? sessionId, event),
			));
		return runtime.session.modelRuntime.getAvailableSnapshot().map((model) => this.modelView(model));
	}

	async selectModel(sessionId: string, provider: string, modelId: string): Promise<DesktopModel> {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? sessionId, event),
			));
		const model = runtime.session.modelRuntime
			.getAvailableSnapshot()
			.find((candidate) => candidate.provider === provider && candidate.id === modelId);
		if (!model) throw new Error(`Model is not available: ${provider}/${modelId}`);
		await this.sessions.runExclusive(record.file, () => runtime.session.setModel(model));
		await this.emitSnapshot();
		return this.modelView(model);
	}

	async getScopedModels(sessionId: string): Promise<DesktopScopedModel[]> {
		const { runtime } = await this.sessionRuntime(sessionId);
		return runtime.session.scopedModels.map((entry) => ({
			provider: entry.model.provider,
			modelId: entry.model.id,
			thinkingLevel: entry.thinkingLevel as DesktopThinkingLevel | undefined,
		}));
	}

	async setScopedModels(sessionId: string, models: DesktopScopedModel[]): Promise<void> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const available = runtime.session.modelRuntime.getAvailableSnapshot();
		const scoped = models.map((entry) => {
			const model = available.find(
				(candidate) => candidate.provider === entry.provider && candidate.id === entry.modelId,
			);
			if (!model) throw new Error(`Model is not available: ${entry.provider}/${entry.modelId}`);
			return { model, thinkingLevel: entry.thinkingLevel };
		});
		await this.sessions.runExclusive(record.file, async () => {
			runtime.session.setScopedModels(scoped);
		});
		await this.emitSnapshot();
	}

	async getModelsProviders(sessionId: string): Promise<DesktopModelsProviders> {
		const { runtime } = await this.sessionRuntime(sessionId);
		return this.modelsProvidersView(runtime);
	}

	async refreshModelsProviders(sessionId: string): Promise<DesktopModelsProviders> {
		const { runtime } = await this.sessionRuntime(sessionId);
		await runtime.session.modelRuntime.refresh({ allowNetwork: false });
		await this.emitSnapshot();
		return this.modelsProvidersView(runtime);
	}

	async setProviderApiKey(sessionId: string, provider: string, apiKey: string): Promise<DesktopModelsProviders> {
		if (!apiKey.trim()) throw new Error("API key cannot be empty");
		const { record, runtime } = await this.sessionRuntime(sessionId);
		await runtime.session.modelRuntime.setRuntimeApiKey(provider, apiKey.trim());
		// A newly configured provider should make the chat immediately usable.
		// The agent core deliberately does not auto-select a model after a
		// credential change, so choose the first authenticated model here when
		// the session has not selected one yet. Users can still change it later
		// from the model selector.
		if (!runtime.session.model) {
			const firstAvailable = runtime.session.modelRuntime.getAvailableSnapshot()[0];
			if (firstAvailable) {
				await this.sessions.runExclusive(record.file, () => runtime.session.setModel(firstAvailable));
			}
		}
		await this.emitSnapshot();
		return this.modelsProvidersView(runtime);
	}

	async removeProviderApiKey(sessionId: string, provider: string): Promise<DesktopModelsProviders> {
		const { runtime } = await this.sessionRuntime(sessionId);
		await runtime.session.modelRuntime.removeRuntimeApiKey(provider);
		await this.emitSnapshot();
		return this.modelsProvidersView(runtime);
	}

	async loginProvider(sessionId: string, provider: string): Promise<DesktopModelsProviders> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const providerConfig = runtime.session.modelRuntime.getProvider(provider);
		if (!providerConfig?.auth.oauth) throw new Error(`Provider does not support account login: ${provider}`);
		const signal = AbortSignal.timeout(10 * 60_000);
		await runtime.session.modelRuntime.login(provider, "oauth", {
			signal,
			prompt: async (prompt) => {
				const promptSignal = prompt.signal ?? signal;
				if (promptSignal.aborted) throw new Error("Login cancelled");
				if (prompt.type === "select") {
					const labels = prompt.options.map((option) => option.label);
					const response = await this.extensionUIDialog(
						record.file,
						{ kind: "select", title: prompt.message, options: labels },
						{ signal: promptSignal },
					);
					if (response.outcome !== "selected") throw new Error("Login cancelled");
					const option = prompt.options.find((candidate) => candidate.label === response.value);
					if (!option) throw new Error("Login selection is no longer available");
					return option.id;
				}
				const response = await this.extensionUIDialog(
					record.file,
					{ kind: "input", title: prompt.message, placeholder: prompt.placeholder },
					{ signal: promptSignal },
				);
				if (response.outcome !== "entered") throw new Error("Login cancelled");
				return response.value;
			},
			notify: (event) => {
				if (event.type === "auth_url") {
					void shell.openExternal(event.url);
					this.emit({
						type: "notification",
						notification: {
							id: randomUUID(),
							level: "info",
							title: "Continue authentication in your browser",
							body: event.instructions ?? event.url,
							sessionId,
						},
					});
					return;
				}
				if (event.type === "device_code") {
					clipboard.writeText(event.userCode);
					void shell.openExternal(event.verificationUri);
					this.emit({
						type: "notification",
						notification: {
							id: randomUUID(),
							level: "info",
							title: "Enter the device code in your browser",
							body: event.userCode,
							sessionId,
						},
					});
					return;
				}
				this.emit({
					type: "notification",
					notification: {
						id: randomUUID(),
						level: "info",
						title: event.type === "progress" ? "Authentication" : "Provider information",
						body: event.message,
						sessionId,
					},
				});
			},
		});
		if (!runtime.session.model) {
			const model = runtime.session.modelRuntime
				.getAvailableSnapshot()
				.find((candidate) => candidate.provider === provider);
			if (model) await this.sessions.runExclusive(record.file, () => runtime.session.setModel(model));
		}
		await this.emitSnapshot();
		return this.modelsProvidersView(runtime);
	}

	async logoutProvider(sessionId: string, provider: string): Promise<DesktopModelsProviders> {
		const { runtime } = await this.sessionRuntime(sessionId);
		await runtime.session.modelRuntime.logout(provider, { signal: AbortSignal.timeout(15_000) });
		await this.emitSnapshot();
		return this.modelsProvidersView(runtime);
	}

	async setProjectTrust(sessionId: string, trusted: boolean): Promise<void> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		await this.sessions.runExclusive(record.file, async () => {
			runtime.session.settingsManager.setProjectTrusted(trusted);
		});
		await this.emitSnapshot();
	}

	async listSlashCommands(sessionId: string): Promise<DesktopSlashCommand[]> {
		const { runtime } = await this.sessionRuntime(sessionId);
		const titleFor = (name: string): string =>
			name
				.replace(/^skill:/, "")
				.replace(/[-_]/g, " ")
				.replace(/\b\w/g, (letter) => letter.toUpperCase());
		const commands: DesktopSlashCommand[] = [];
		const seen = new Set<string>();
		const add = (command: DesktopSlashCommand): void => {
			if (seen.has(command.command)) return;
			seen.add(command.command);
			commands.push(command);
		};
		for (const command of DESKTOP_BUILTIN_SLASH_COMMANDS) {
			add({
				id: `builtin:${command.name}`,
				command: `/${command.name}`,
				title: titleFor(command.name),
				description: command.description,
				section: "Pi",
				argumentHint: command.argumentHint ?? (command.name === "name" ? "<name>" : undefined),
				source: "builtin",
			});
		}
		for (const command of runtime.session.extensionRunner.getRegisteredCommands()) {
			add({
				id: `extension:${command.invocationName}`,
				command: `/${command.invocationName}`,
				title: titleFor(command.invocationName),
				description: command.description || "Plugin command",
				section: "Extensions",
				source: "extension",
			});
		}
		for (const prompt of runtime.session.promptTemplates) {
			add({
				id: `prompt:${prompt.name}`,
				command: `/${prompt.name}`,
				title: titleFor(prompt.name),
				description: prompt.description || "Prompt template",
				section: "Prompts",
				argumentHint: prompt.argumentHint,
				source: "prompt",
			});
		}
		if (runtime.session.settingsManager.getEnableSkillCommands()) {
			for (const skill of runtime.session.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				add({
					id: `skill:${skill.name}`,
					command: `/${name}`,
					title: titleFor(name),
					description: skill.description || "Skill command",
					section: "Skills",
					source: "skill",
				});
			}
		}
		return commands;
	}

	async executeSlashCommand(sessionId: string, command: string, args = ""): Promise<{ sessionId?: string }> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const hasExtensionCommand = !!runtime.session.extensionRunner.getCommand(command);
		const hasPrompt = runtime.session.promptTemplates.some((prompt) => prompt.name === command);
		const hasSkill = runtime.session.resourceLoader
			.getSkills()
			.skills.some((skill) => `skill:${skill.name}` === command);
		if (!hasExtensionCommand && !hasPrompt && !hasSkill) {
			throw new Error(`/${command} is not an extension, prompt, or skill command in this session`);
		}
		this.extensionErrors.delete(record.file);
		const text = `/${command}${args.trim() ? ` ${args.trim()}` : ""}`;
		const sessionFile = record.file;
		await this.sessions.runExclusive(sessionFile, () => runtime.session.prompt(text, { source: "interactive" }));
		const extensionError = this.extensionErrors.get(sessionFile) ?? this.extensionErrors.get(record.file);
		this.extensionErrors.delete(sessionFile);
		if (extensionError) throw new Error(extensionError);
		await this.emitSnapshot();
		return { sessionId: this.sessionIdForFile(record.file) };
	}

	async importSession(sessionId: string, inputPath: string): Promise<{ sessionId?: string }> {
		const { record } = await this.sessionRuntime(sessionId);
		const sessionFile = record.file;
		await this.sessions.runExclusive(sessionFile, () =>
			this.sessions.importSession(sessionFile, inputPath, record.cwd),
		);
		await this.emitSnapshot();
		return { sessionId: this.sessionIdForFile(record.file) };
	}

	async forkSession(sessionId: string, entryId?: string): Promise<{ sessionId?: string }> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const target = entryId ?? runtime.session.getUserMessagesForForking().at(-1)?.entryId;
		if (!target) throw new Error("Nothing to fork yet");
		const sessionFile = record.file;
		await this.sessions.runExclusive(sessionFile, () => this.sessions.forkSession(sessionFile, target));
		await this.emitSnapshot();
		return { sessionId: this.sessionIdForFile(record.file) };
	}

	async cloneSession(sessionId: string): Promise<{ sessionId?: string }> {
		const { record } = await this.sessionRuntime(sessionId);
		const sessionFile = record.file;
		await this.sessions.runExclusive(sessionFile, () => this.sessions.cloneSession(sessionFile));
		await this.emitSnapshot();
		return { sessionId: this.sessionIdForFile(record.file) };
	}

	async reloadSession(sessionId: string): Promise<void> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		await this.sessions.runExclusive(record.file, () => runtime.session.reload());
		await this.emitSnapshot();
	}

	async setSessionName(sessionId: string, name: string): Promise<void> {
		const normalized = name.replace(/[\r\n]+/g, " ").trim();
		if (!normalized) throw new Error("Session name cannot be empty");
		const { record, runtime } = await this.sessionRuntime(sessionId);
		await this.sessions.runExclusive(record.file, async () => {
			runtime.session.setSessionName(normalized);
		});
		await this.emitSnapshot();
	}

	async setSessionMode(sessionId: string, mode: DesktopMode): Promise<DesktopMode> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const current = this.sessionMode(runtime.session);
		if (current === mode) return current;
		if (!runtime.session.extensionRunner.getCommand("plan")) {
			throw new Error("Plan mode is unavailable. Enable the CLI plan-mode extension first.");
		}
		await this.sessions.runExclusive(record.file, () => runtime.session.prompt("/plan", { source: "interactive" }));
		await this.emitSnapshot();
		return this.sessionMode(runtime.session);
	}

	async setThinkingLevel(sessionId: string, level: DesktopThinkingLevel): Promise<DesktopThinkingLevel> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		if (!runtime.session.getAvailableThinkingLevels().includes(level)) {
			throw new Error(`Thinking level is not available for this model: ${level}`);
		}
		await this.sessions.runExclusive(record.file, async () => {
			runtime.session.setThinkingLevel(level);
		});
		await this.emitSnapshot();
		return runtime.session.thinkingLevel as DesktopThinkingLevel;
	}

	async compactSession(sessionId: string, customInstructions?: string): Promise<void> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		if (runtime.session.isStreaming) throw new Error("Wait for the current response to finish before compacting");
		const instructions = customInstructions?.trim() || undefined;
		await this.sessions.runExclusive(record.file, () => runtime.session.compact(instructions));
		await this.emitSnapshot();
	}

	async getSessionStats(sessionId: string): Promise<DesktopSessionStats> {
		const { runtime } = await this.sessionRuntime(sessionId);
		const stats: SessionStats = runtime.session.getSessionStats();
		return {
			sessionFile: stats.sessionFile,
			sessionId: stats.sessionId,
			userMessages: stats.userMessages,
			assistantMessages: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			toolResults: stats.toolResults,
			totalMessages: stats.totalMessages,
			tokens: { ...stats.tokens },
			cost: stats.cost,
			contextUsage: stats.contextUsage ? { ...stats.contextUsage } : undefined,
		};
	}

	async shareSession(sessionId: string): Promise<{ gistUrl: string; previewUrl: string }> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const temporaryPath = join(tmpdir(), `pi-session-${randomUUID()}.html`);
		try {
			await execFileAsync("gh", ["auth", "status"], { windowsHide: true, encoding: "utf8" });
			await this.sessions.runExclusive(record.file, () => runtime.session.exportToHtml(temporaryPath));
			const { stdout } = await execFileAsync("gh", ["gist", "create", "--public=false", temporaryPath], {
				windowsHide: true,
				encoding: "utf8",
			});
			const gistUrl = stdout.trim();
			const gistId = gistUrl.split("/").filter(Boolean).at(-1);
			if (!gistId || !/^https:\/\/gist\.github\.com\//i.test(gistUrl))
				throw new Error("GitHub CLI returned an invalid gist URL");
			const shareBase = process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";
			return { gistUrl, previewUrl: `${shareBase}#${gistId}` };
		} catch (reason) {
			const message = readableError(reason);
			if (/ENOENT|not recognized|not found/i.test(message))
				throw new Error("GitHub CLI (gh) is not installed or is not available on PATH");
			if (/auth|logged in/i.test(message))
				throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
			throw new Error(`Failed to share session: ${message}`);
		} finally {
			await unlink(temporaryPath).catch(() => undefined);
		}
	}

	async exportSession(sessionId: string, format: "html" | "jsonl" = "html", requestedPath?: string): Promise<string> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		const filename = `pi-session-${new Date().toISOString().replace(/[.:]/g, "-")}.${format}`;
		const normalizedPath = requestedPath?.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
		const outputPath = normalizedPath ? resolve(record.cwd, normalizedPath) : join(record.cwd, filename);
		let result = outputPath;
		await this.sessions.runExclusive(record.file, async () => {
			result =
				format === "jsonl"
					? runtime.session.exportToJsonl(outputPath)
					: await runtime.session.exportToHtml(outputPath);
		});
		return result;
	}

	async getSessionTree(sessionId: string): Promise<DesktopSessionTree> {
		const { runtime } = await this.sessionRuntime(sessionId);
		const leafId = runtime.session.sessionManager.getLeafId();
		return { leafId: leafId ?? undefined, nodes: this.flattenTree(runtime.session.sessionManager.getTree(), leafId) };
	}

	async navigateSessionTree(
		sessionId: string,
		targetId: string,
	): Promise<{ editorText?: string; cancelled: boolean }> {
		const { record, runtime } = await this.sessionRuntime(sessionId);
		let result: { editorText?: string; cancelled: boolean } | undefined;
		await this.sessions.runExclusive(record.file, async () => {
			result = await runtime.session.navigateTree(targetId);
		});
		await this.emitSnapshot();
		return result ?? { cancelled: true };
	}

	async sendInput(input: SendInput): Promise<unknown> {
		await this.discoverSessions();
		const record = this.runtimes.get(input.sessionId);
		if (!record) throw new Error(`Unknown session: ${input.sessionId}`);
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? input.sessionId, event),
			));
		if (input.deliveryMode) {
			if (input.imagePaths?.length) throw new Error("Images cannot be deferred to an automation yet");
			const result = await this.wakeService.queueInput({
				sessionId: input.sessionId,
				wakeId: input.wakeId,
				clientMessageId: input.clientMessageId,
				content: input.text,
			});
			await runtime.session.sendCustomMessage(
				{
					customType: "desktop_deferred_input",
					content: [{ type: "text", text: input.text }],
					display: true,
					details: { wakeId: result.wakeId, clientMessageId: input.clientMessageId },
				},
				{ deliverAs: "nextTurn" },
			);
			if (input.deliveryMode === "wake_now") {
				const job = (await this.wakeStore.listBySession(input.sessionId)).find(
					(candidate) => candidate.id === result.wakeId,
				);
				if (job?.status === "armed") {
					await this.wakeStore.markReady(job.id, {
						cause: job.trigger.type === "time" ? "time_due" : "monitor_timeout",
						satisfiedAt: new Date().toISOString(),
					});
					void this.outerLoopRuntime.scheduler.requestTick();
				}
			}
			await this.emitSnapshot();
			return result;
		}
		try {
			const images = input.imagePaths?.length
				? await Promise.all(
						input.imagePaths.map(async (path) => {
							const bytes = await readFile(path);
							if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`Image is larger than 20 MB: ${path}`);
							return { type: "image" as const, data: bytes.toString("base64"), mimeType: imageMimeType(path) };
						}),
					)
				: undefined;
			const prompt = () =>
				runtime.session.prompt(input.text, {
					source: "interactive",
					images,
					streamingBehavior: runtime.session.isStreaming ? (input.streamingBehavior ?? "steer") : undefined,
				});
			if (runtime.session.isStreaming) await prompt();
			else await this.sessions.runExclusive(record.file, prompt);
		} catch (reason) {
			const error = readableError(reason);
			if (!record.runError)
				this.recordStatus(input.sessionId, "run_error", error, error, {
					startNew: !record.currentRunActivityId || record.currentRunSettled,
				});
			await this.emitSnapshot();
			throw new Error(error);
		}
		return undefined;
	}

	async runSessionCommand(
		sessionId: string,
		command: string,
		excludeFromContext = false,
	): Promise<DesktopTerminalResult> {
		const normalized = command.trim();
		if (!normalized) throw new Error("Terminal command cannot be empty");
		const { record, runtime } = await this.sessionRuntime(sessionId);
		if (runtime.session.isBashRunning) throw new Error("A terminal command is already running in this chat");
		const started = Date.now();
		const result = await runtime.session.executeBash(normalized, undefined, { excludeFromContext });
		const completed = Date.now();
		await this.emitSnapshot();
		return {
			executionId: randomUUID(),
			command: normalized,
			cwd: record.cwd,
			nextCwd: record.cwd,
			stdout: result.output,
			stderr: "",
			exitCode: result.exitCode ?? 1,
			startedAt: new Date(started).toISOString(),
			completedAt: new Date(completed).toISOString(),
			durationMs: completed - started,
			cancelled: false,
		};
	}

	async createWake(sessionId: string, request: Omit<CreateWakeInput, "requestKey" | "session" | "now">) {
		await this.discoverSessions();
		const record = this.runtimes.get(sessionId);
		if (!record) throw new Error(`Unknown session: ${sessionId}`);
		const input: CreateWakeInput = normalizeCreateWakeInput({
			...request,
			requestKey: `gui:${sessionId}:${randomUUID()}`,
			session: { id: sessionId, file: record.file, cwd: record.cwd },
		});
		if (input.trigger.type === "monitor") this.monitorRegistry.require(input.trigger.adapter);
		const result = await this.wakeStore.createOnce(input);
		if (result.job.trigger.type === "monitor") await this.outerLoopRuntime.scheduler.sampleNow(result.job);
		const view = (await this.wakeService.list(sessionId, true)).find((job) => job.id === result.job.id);
		if (!view) throw new Error("Created Wake Job could not be read back");
		this.emit({ type: "wake.changed", wake: view });
		await this.emitSnapshot();
		return view;
	}

	listWakeups(sessionId: string, includeTerminal = false) {
		return this.wakeService.list(sessionId, includeTerminal);
	}

	getMonitorAdapters(): string[] {
		return this.monitorRegistry.list().map((adapter) => adapter.name);
	}

	getSettings() {
		return {
			cwd: this.options.cwd,
			dataDirectory: this.options.dataDirectory,
			agentDirectory: getAgentDir(),
			scheduler: "running" as const,
		};
	}

	getChangelog(): Promise<string> {
		return readFile(join(getPackageDir(), "CHANGELOG.md"), "utf8");
	}

	async abortSession(sessionId: string): Promise<void> {
		const record = this.runtimes.get(sessionId);
		if (!record) return;
		const runtime =
			this.sessions.get(record.file) ??
			(await this.sessions.ensureOpen(record.file, record.cwd, (event) =>
				this.onAgentEvent(this.sessionIdForFile(record.file) ?? sessionId, event),
			));
		runtime.session.abortBash();
		await runtime.session.abort();
	}

	async cancelWake(sessionId: string, wakeId: string) {
		const view = await this.wakeService.cancel(sessionId, wakeId);
		this.emit({ type: "wake.changed", wake: view });
		await this.emitSnapshot();
		return view;
	}

	async getInbox(wakeId: string) {
		return this.wakeService.getInbox(wakeId);
	}

	async dispose(): Promise<void> {
		for (const requestId of [...this.pendingUIRequests.keys()])
			this.settleUIRequest(requestId, { outcome: "cancelled" }, true);
		this.disposed = true;
		await this.sessions.dispose();
		await this.outerLoopRuntime.stop();
	}
}

export function installDesktopIpc(controller: DesktopController): void {
	// Registered in main.ts to keep Electron imports out of service modules.
	void controller;
}

export type { DesktopApi };
