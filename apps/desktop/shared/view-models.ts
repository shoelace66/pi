import type { JsonValue, WakeCause, WakeStatus } from "@earendil-works/pi-coding-agent";

export type DesktopSessionStatus = "running" | "sleeping" | "wake_ready" | "retry_wait" | "blocked" | "idle" | "error";

export type DesktopThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The two user-facing execution modes exposed by the CLI plan-mode extension. */
export type DesktopMode = "build" | "plan";

export type DesktopMessage = {
	id: string;
	role: "user" | "assistant" | "tool" | "custom" | "system";
	customType?: string;
	text: string;
	thinking?: string;
	details?: unknown;
	timestamp?: number;
};

export type DesktopToolExecution = {
	id: string;
	toolName: string;
	status: "running" | "completed" | "error";
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	startedAt: string;
	updatedAt: string;
};

export type DesktopModel = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
};

export type DesktopScopedModel = {
	provider: string;
	modelId: string;
	thinkingLevel?: DesktopThinkingLevel;
};

export type DesktopProvider = {
	id: string;
	name: string;
	auth: Array<"api_key" | "oauth">;
	configured: boolean;
	configuredAuthType?: "api_key" | "oauth";
	authSource?: string;
	modelCount: number;
	availableModelCount: number;
};

export type DesktopModelsProviders = {
	providers: DesktopProvider[];
	models: DesktopModel[];
	runtimeError?: string;
};

export type DesktopSlashCommand = {
	id: string;
	command: string;
	title: string;
	description: string;
	section: string;
	argumentHint?: string;
	source: "builtin" | "desktop" | "extension" | "prompt" | "skill";
};

export type DesktopTreeNode = {
	id: string;
	parentId: string | null;
	kind: string;
	label?: string;
	preview: string;
	timestamp: string;
	depth: number;
	hasChildren: boolean;
	active: boolean;
};

export type DesktopSessionTree = {
	leafId?: string;
	nodes: DesktopTreeNode[];
};

export type DesktopRunStatus = "run_started" | "run_completed" | "run_error";

export type DesktopRunPhase =
	| "preparing"
	| "reasoning"
	| "tool"
	| "reviewing"
	| "responding"
	| "compacting"
	| "retrying"
	| "finalizing";

export type DesktopActivity =
	| { kind: "message"; id: string; occurredAt: string; message: DesktopMessage }
	| { kind: "tool"; id: string; occurredAt: string; tool: DesktopToolExecution }
	| {
			kind: "status";
			id: string;
			occurredAt: string;
			status: DesktopRunStatus;
			phase?: DesktopRunPhase;
			message?: string;
			rawError?: string;
			retryable?: boolean;
	  };

export type WakeJobView = {
	id: string;
	sessionId: string;
	status: WakeStatus;
	kind: "time" | "monitor";
	reason: string;
	objective: string;
	checkFirst: string[];
	triggerLabel: string;
	dueAt?: string;
	nextCheckAt?: string;
	cause?: WakeCause;
	observation?: { observedAt: string; summary: string; fields: Record<string, JsonValue> };
	pendingInboxCount: number;
	runAttempt: number;
	maxRunAttempts: number;
	error?: { code: string; message: string; retriable: boolean };
	createdAt: string;
	updatedAt: string;
};

export type DeferredMessageView = {
	id: string;
	clientMessageId: string;
	wakeId: string;
	content: string;
	createdAt: string;
	status: "pending" | "delivering" | "delivered" | "cancelled";
};

export type DesktopSessionSnapshot = {
	id: string;
	name?: string;
	cwd: string;
	sessionFile: string;
	status: DesktopSessionStatus;
	messages: DesktopMessage[];
	toolExecutions: DesktopToolExecution[];
	activities: DesktopActivity[];
	model?: DesktopModel;
	mode: DesktopMode;
	thinkingLevel: DesktopThinkingLevel;
	availableThinkingLevels: DesktopThinkingLevel[];
	queue: {
		steering: string[];
		followUp: string[];
	};
	isCompacting: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	projectTrusted: boolean;
	wakeJobs: WakeJobView[];
	runtime: {
		outerLoopEnabled: boolean;
		scheduler: "running";
		monitorAdapters: string[];
		activeTools: string[];
		extensionCommands: string[];
		promptTemplates: string[];
		skills: string[];
	};
	updatedAt: string;
};

export type DesktopSessionStats = {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
};

export type DesktopFileEntry = {
	path: string;
	name: string;
	kind: "file" | "directory";
	size?: number;
	modifiedAt?: string;
};

export type DesktopFileListing = {
	entries: DesktopFileEntry[];
	truncated: boolean;
	limit: number;
	unreadableCount: number;
};

export type DesktopChangeEntry = {
	path: string;
	originalPath?: string;
	status: string;
	staged: boolean;
	unstaged: boolean;
};

export type DesktopWorkspaceChanges = {
	repository: boolean;
	entries: DesktopChangeEntry[];
	error?: string;
};

export type DesktopTerminalResult = {
	executionId: string;
	command: string;
	cwd: string;
	nextCwd: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	cancelled: boolean;
};

export type SessionListItem = Pick<DesktopSessionSnapshot, "id" | "name" | "cwd" | "status" | "updatedAt"> & {
	wakeCount: number;
	messageCount: number;
	preview?: string;
};

export type DesktopNotification = {
	id: string;
	level: "info" | "success" | "warning" | "error";
	title: string;
	body: string;
	sessionId?: string;
	wakeId?: string;
};

/**
 * Interactive request raised by an extension through `ctx.ui.select/confirm/input`.
 * Main assigns the requestId and routes the request to the renderer modal.
 */
export type DesktopExtensionUIRequest =
	| { requestId: string; sessionId: string; kind: "select"; title: string; options: string[]; timeout?: number }
	| { requestId: string; sessionId: string; kind: "confirm"; title: string; message: string; timeout?: number }
	| { requestId: string; sessionId: string; kind: "input"; title: string; placeholder?: string; timeout?: number };

/** Renderer answer for a DesktopExtensionUIRequest, correlated by requestId. */
export type DesktopExtensionUIResponse =
	| { requestId: string; outcome: "selected"; value: string }
	| { requestId: string; outcome: "confirmed"; value: boolean }
	| { requestId: string; outcome: "entered"; value: string }
	| { requestId: string; outcome: "cancelled" };

export type DesktopSnapshot = {
	version: 1;
	activeSessionId?: string;
	sessions: SessionListItem[];
	activeSession?: DesktopSessionSnapshot;
	updatedAt: string;
};
