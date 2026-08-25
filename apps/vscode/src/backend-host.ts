import path from "node:path";
import * as vscode from "vscode";
import { RpcClient } from "../../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import type {
	RpcAutomation,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcProtocolEvent,
	RpcSessionState,
} from "../../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import type { JsonAgentSessionEvent } from "../../../packages/coding-agent/src/modes/json-event.ts";
import type { UiActivity, UiCommand, UiMessage, UiRequest } from "../shared/protocol.ts";
import { apiKeySecretKey } from "./api-key-secret.ts";
import { resolveBundledBackend } from "./backend-runtime.ts";
import { messageText, messageThinking, toUiAutomations, toUiMessages } from "./view-model.ts";

const nodeScriptExtensions = new Set([".js", ".mjs", ".cjs"]);
type AssistantMessageUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

const builtInCommands: UiCommand[] = [
	{ name: "login", description: "配置当前工作区的模型服务密钥", argumentHint: "[provider]", source: "builtin" },
	{ name: "logout", description: "删除当前工作区的模型服务密钥", argumentHint: "[provider]", source: "builtin" },
	{ name: "new", description: "开始新会话", source: "builtin" },
	{ name: "resume", description: "选择并继续历史会话", argumentHint: "[session-path]", source: "builtin" },
	{ name: "model", description: "切换模型", argumentHint: "<provider/model>", source: "builtin" },
	{ name: "thinking", description: "设置思考强度", argumentHint: "<level>", source: "builtin" },
	{ name: "compact", description: "压缩当前会话上下文", argumentHint: "[instructions]", source: "builtin" },
	{ name: "export", description: "导出当前会话为 HTML", argumentHint: "[path]", source: "builtin" },
	{ name: "name", description: "设置当前会话名称", argumentHint: "<name>", source: "builtin" },
	{ name: "copy", description: "复制最后一条 AutoPi 回复", source: "builtin" },
	{ name: "clone", description: "复制当前会话", source: "builtin" },
];

export type BackendSnapshot = {
	connection: "starting" | "ready" | "running" | "error";
	model: string;
	sessionName: string;
	messages: Awaited<ReturnType<typeof toUiMessages>>;
	commands: UiCommand[];
	automations: ReturnType<typeof toUiAutomations>;
	activities: UiActivity[];
	pendingRequest?: UiRequest;
	notice?: string;
	error?: string;
};

type BackendHostCallbacks = {
	onChanged: () => void;
	onComposerText: (text: string) => void;
};

export class WorkspaceBackendHost implements vscode.Disposable {
	readonly folder: vscode.WorkspaceFolder;
	private readonly context: vscode.ExtensionContext;
	private readonly callbacks: BackendHostCallbacks;
	private client?: RpcClient;
	private startPromise?: Promise<void>;
	private connection: BackendSnapshot["connection"] = "starting";
	private state?: RpcSessionState;
	private messages: BackendSnapshot["messages"] = [];
	private commands: UiCommand[] = builtInCommands;
	private streamingMessage?: UiMessage;
	private streamingChangedTimer?: ReturnType<typeof setTimeout>;
	private automations: RpcAutomation[] = [];
	private activities = new Map<string, UiActivity>();
	private pendingRequest?: UiRequest;
	private notice?: string;
	private error?: string;
	private refreshPromise?: Promise<void>;
	private disposed = false;
	private stopPromise?: Promise<void>;

	constructor(folder: vscode.WorkspaceFolder, context: vscode.ExtensionContext, callbacks: BackendHostCallbacks) {
		this.folder = folder;
		this.context = context;
		this.callbacks = callbacks;
	}

	async ensureStarted(): Promise<void> {
		if (this.disposed) throw new Error("AutoPi backend host has been disposed");
		if (!vscode.workspace.isTrusted) throw new Error("请先信任当前工作区，再启动 AutoPi。");
		if (this.client) return;
		this.startPromise ??= this.start();
		await this.startPromise;
	}

	async prompt(text: string): Promise<void> {
		if (this.connection === "running") {
			throw new Error("AutoPi 正在执行，请等待完成或先停止当前任务。");
		}
		await this.ensureStarted();
		const normalizedText = text.trim().startsWith("\\") ? `/${text.trim().slice(1)}` : text.trim();
		if (await this.tryRunBuiltInCommand(normalizedText)) {
			await this.refresh();
			return;
		}
		if (normalizedText.startsWith("/")) {
			const name = /^\/([^\s]+)/.exec(normalizedText)?.[1];
			const command = this.commands.find((candidate) => candidate.name === name);
			if (!command) throw new Error(`未知命令 /${name ?? ""}。输入 / 查看可用命令。`);
			if (command.source === "builtin") throw new Error(`命令 /${command.name} 无法在当前界面执行。`);
		}
		this.connection = "running";
		this.streamingMessage = undefined;
		this.error = undefined;
		this.callbacks.onChanged();
		try {
			await this.client?.prompt(normalizedText);
			await this.refresh();
		} catch (error) {
			this.fail(error);
			throw error;
		}
	}

	async abort(): Promise<void> {
		await this.client?.abort();
	}

	async newSession(): Promise<void> {
		await this.ensureStarted();
		await this.client?.newSession();
		this.activities.clear();
		this.streamingMessage = undefined;
		this.pendingRequest = undefined;
		await this.refresh();
	}

	async cancelAutomation(automationId: string): Promise<void> {
		await this.ensureStarted();
		await this.client?.cancelAutomation(automationId, "Cancelled from the AutoPi VS Code sidebar");
		await this.refresh();
	}

	respondToUi(response: RpcExtensionUIResponse): void {
		this.client?.respondToExtensionUI(response);
		if (this.pendingRequest?.id === response.id) this.pendingRequest = undefined;
		this.callbacks.onChanged();
	}

	async refresh(): Promise<void> {
		if (!this.client) return;
		this.refreshPromise ??= this.refreshNow().finally(() => {
			this.refreshPromise = undefined;
		});
		await this.refreshPromise;
	}

	getSnapshot(): BackendSnapshot {
		const model = this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : "默认模型";
		return {
			connection: this.connection,
			model,
			sessionName: this.state?.sessionName || this.folder.name,
			messages: this.streamingMessage ? [...this.messages, this.streamingMessage] : this.messages,
			commands: this.commands,
			automations: toUiAutomations(this.automations),
			activities: [...this.activities.values()].slice(-30),
			pendingRequest: this.pendingRequest,
			notice: this.notice,
			error: this.error,
		};
	}

	dispose(): void {
		if (this.streamingChangedTimer) clearTimeout(this.streamingChangedTimer);
		void this.stop();
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.disposed = true;
		const client = this.client;
		const starting = this.startPromise;
		this.client = undefined;
		this.stopPromise = (async () => {
			await client?.stop();
			await starting?.catch(() => undefined);
		})().finally(() => {
			this.startPromise = undefined;
		});
		return this.stopPromise;
	}

	private async start(): Promise<void> {
		this.connection = "starting";
		this.callbacks.onChanged();
		let startingClient: RpcClient | undefined;
		try {
			const config = vscode.workspace.getConfiguration("autopi", this.folder.uri);
			const configuredPath = config.get<string>("backendPath", "").trim();
			const provider = config.get<string>("provider", "").trim() || undefined;
			const model = config.get<string>("model", "").trim() || undefined;
			const args = config.get<string[]>("backendArgs", []);
			const apiKey = await this.context.secrets.get(apiKeySecretKey(this.folder.uri.toString(), provider));
			const clientOptions = this.resolveBackend(configuredPath);
			const client = new RpcClient({
				...clientOptions,
				cwd: this.folder.uri.fsPath,
				provider,
				model,
				args,
				env: apiKey ? { AUTOPI_RPC_API_KEY: apiKey } : undefined,
				startupTimeoutMs: 45_000,
			});
			startingClient = client;
			client.onEvent((event) => this.handleAgentEvent(event));
			client.onProtocolEvent((event) => this.handleProtocolEvent(event));
			await client.start();
			if (this.disposed) {
				await client.stop();
				return;
			}
			this.client = client;
			this.connection = "ready";
			await this.refreshNow();
		} catch (error) {
			if (this.client === startingClient) this.client = undefined;
			await startingClient?.stop().catch(() => undefined);
			this.startPromise = undefined;
			this.fail(error);
			throw error;
		}
	}

	private resolveBackend(configuredPath: string): {
		executablePath?: string;
		executableArgs?: string[];
		cliPath?: string;
	} {
		if (configuredPath) {
			const expanded = configuredPath.replace(/\$\{workspaceFolder\}/g, this.folder.uri.fsPath);
			return nodeScriptExtensions.has(path.extname(expanded).toLowerCase())
				? { cliPath: expanded }
				: { executablePath: expanded };
		}
		return resolveBundledBackend(this.context.extensionUri.fsPath);
	}

	private async refreshNow(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const [state, messages, automations, commands] = await Promise.all([
			client.getState(),
			client.getMessages(),
			client.listAutomations(true),
			client.getCommands(),
		]);
		this.state = state;
		const streamingMessage = this.streamingMessage;
		this.messages = await toUiMessages(messages, this.folder.uri.fsPath);
		if (this.streamingMessage === streamingMessage) this.streamingMessage = undefined;
		const builtInNames = new Set(builtInCommands.map((command) => command.name));
		this.commands = [
			...builtInCommands,
			...commands
				.filter((command) => !builtInNames.has(command.name))
				.map((command) => ({
					name: command.name,
					description: command.description || command.name,
					source: command.source,
				})),
		];
		this.automations = automations;
		this.notice = this.messages
			.map((message) => message.text)
			.find((text) => text.includes("AutoPi recovery notice"));
		this.connection = state.isStreaming ? "running" : "ready";
		this.error = undefined;
		this.callbacks.onChanged();
	}

	private handleProtocolEvent(event: RpcProtocolEvent): void {
		if (event.type === "automation_changed") {
			this.automations = event.automations;
			this.callbacks.onChanged();
			return;
		}
		if (event.type !== "extension_ui_request") return;
		this.handleExtensionRequest(event);
	}

	private handleExtensionRequest(request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(request.message);
				return;
			}
			case "set_editor_text":
				this.callbacks.onComposerText(request.text);
				return;
			case "setStatus":
			case "setWidget":
			case "setTitle":
				return;
			case "confirm":
				this.pendingRequest = {
					id: request.id,
					method: "confirm",
					title: request.title,
					message: request.message,
				};
				break;
			case "select":
				this.pendingRequest = {
					id: request.id,
					method: "select",
					title: request.title,
					options: request.options,
				};
				break;
			case "input":
				this.pendingRequest = {
					id: request.id,
					method: "input",
					title: request.title,
					initialValue: request.placeholder,
				};
				break;
			case "editor":
				this.pendingRequest = {
					id: request.id,
					method: "editor",
					title: request.title,
					initialValue: request.prefill,
				};
				break;
		}
		this.callbacks.onChanged();
	}

	private handleAgentEvent(event: JsonAgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.connection = "running";
				this.callbacks.onChanged();
				return;
			case "message_start": {
				const role = (event.message as unknown as { role?: unknown }).role;
				if (role !== "assistant") return;
				this.streamingMessage = {
					id: "streaming-assistant",
					role: "assistant",
					text: messageText(event.message),
					thinking: messageThinking(event.message) || undefined,
					streaming: true,
					artifacts: [],
				};
				return;
			}
			case "message_update":
				this.applyMessageUpdate(event.assistantMessageEvent);
				return;
			case "tool_execution_start":
				this.activities.set(event.toolCallId, {
					id: event.toolCallId,
					tool: event.toolName,
					detail: this.describe(event.args),
					status: "running",
				});
				this.callbacks.onChanged();
				return;
			case "tool_execution_end": {
				const current = this.activities.get(event.toolCallId);
				this.activities.set(event.toolCallId, {
					id: event.toolCallId,
					tool: event.toolName,
					detail: current?.detail || this.describe(event.result),
					status: event.isError ? "failed" : "succeeded",
				});
				this.callbacks.onChanged();
				return;
			}
			case "message_end":
				if ((event.message as unknown as { role?: unknown }).role === "assistant") {
					this.streamingMessage = {
						id: "streaming-assistant",
						role: "assistant",
						text: messageText(event.message),
						thinking: messageThinking(event.message) || undefined,
						streaming: true,
						artifacts: [],
					};
					this.flushStreamingChanged();
				}
				void this.refresh();
				return;
			case "agent_settled":
				void this.refresh();
				return;
		}
	}

	private applyMessageUpdate(event: AssistantMessageUpdate): void {
		this.streamingMessage ??= {
			id: "streaming-assistant",
			role: "assistant",
			text: "",
			streaming: true,
			artifacts: [],
		};
		switch (event.type) {
			case "text_delta":
				this.streamingMessage.text += event.delta;
				break;
			case "text_end":
				this.streamingMessage.text = event.content;
				break;
			case "thinking_delta":
				this.streamingMessage.thinking = `${this.streamingMessage.thinking ?? ""}${event.delta}`;
				break;
			case "thinking_end":
				this.streamingMessage.thinking = event.content;
				break;
			default:
				return;
		}
		this.scheduleStreamingChanged();
	}

	private async tryRunBuiltInCommand(text: string): Promise<boolean> {
		if (!text.startsWith("/")) return false;
		const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (!match) return false;
		const name = match[1]?.toLowerCase();
		const args = match[2]?.trim() ?? "";
		const client = this.client;
		if (!client) return false;
		switch (name) {
			case "new":
				await client.newSession();
				this.activities.clear();
				this.streamingMessage = undefined;
				return true;
			case "resume": {
				let sessionPath = args;
				if (!sessionPath) {
					const sessions = await client.listSessions();
					if (sessions.length === 0) throw new Error("当前工作区还没有可恢复的历史会话。");
					const selected = await vscode.window.showQuickPick(
						sessions.map((candidate) => ({
							label: candidate.name || candidate.firstMessage || "未命名会话",
							description: new Date(candidate.modified).toLocaleString(),
							detail: `${candidate.messageCount} 条消息 · ${candidate.cwd}`,
							sessionPath: candidate.path,
						})),
						{ title: "恢复 AutoPi 会话", placeHolder: "选择要继续的历史会话", matchOnDescription: true, matchOnDetail: true },
					);
					if (!selected) return true;
					sessionPath = selected.sessionPath;
				}
				const result = await client.switchSession(sessionPath);
				if (!result.cancelled) {
					this.activities.clear();
					this.streamingMessage = undefined;
				}
				return true;
			}
			case "model": {
				const separator = args.indexOf("/");
				if (separator <= 0 || separator === args.length - 1) {
					throw new Error("用法：/model <provider/model>");
				}
				await client.setModel(args.slice(0, separator), args.slice(separator + 1));
				return true;
			}
			case "thinking": {
				const levels = await client.getAvailableThinkingLevels();
				if (!levels.includes(args as (typeof levels)[number])) {
					throw new Error(`用法：/thinking <${levels.join(" | ")}>`);
				}
				await client.setThinkingLevel(args as (typeof levels)[number]);
				return true;
			}
			case "compact":
				await client.compact(args || undefined);
				return true;
			case "export": {
				const result = await client.exportHtml(args || undefined);
				void vscode.window.showInformationMessage(`AutoPi 会话已导出：${result.path}`);
				return true;
			}
			case "name":
				if (!args) throw new Error("用法：/name <name>");
				await client.setSessionName(args);
				return true;
			case "copy": {
				const lastMessage = await client.getLastAssistantText();
				if (!lastMessage) throw new Error("当前会话还没有可复制的 AutoPi 回复。");
				await vscode.env.clipboard.writeText(lastMessage);
				void vscode.window.showInformationMessage("已复制最后一条 AutoPi 回复。");
				return true;
			}
			case "clone":
				await client.clone();
				this.activities.clear();
				this.streamingMessage = undefined;
				return true;
			default:
				return false;
		}
	}

	private scheduleStreamingChanged(): void {
		if (this.streamingChangedTimer) return;
		this.streamingChangedTimer = setTimeout(() => {
			this.streamingChangedTimer = undefined;
			if (!this.disposed) this.callbacks.onChanged();
		}, 50);
	}

	private flushStreamingChanged(): void {
		if (this.streamingChangedTimer) clearTimeout(this.streamingChangedTimer);
		this.streamingChangedTimer = undefined;
		this.callbacks.onChanged();
	}

	private describe(value: unknown): string {
		try {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			return text.length > 360 ? `${text.slice(0, 357)}...` : text;
		} catch {
			return String(value);
		}
	}

	private fail(error: unknown): void {
		this.connection = "error";
		this.error = error instanceof Error ? error.message : String(error);
		this.callbacks.onChanged();
	}
}
