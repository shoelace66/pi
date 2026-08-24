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
import type { UiActivity, UiRequest } from "../shared/protocol.ts";
import { apiKeySecretKey } from "./api-key-secret.ts";
import { resolveBundledBackend } from "./backend-runtime.ts";
import { toUiAutomations, toUiMessages } from "./view-model.ts";

const nodeScriptExtensions = new Set([".js", ".mjs", ".cjs"]);

export type BackendSnapshot = {
	connection: "starting" | "ready" | "running" | "error";
	model: string;
	sessionName: string;
	messages: Awaited<ReturnType<typeof toUiMessages>>;
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
		await this.ensureStarted();
		this.connection = "running";
		this.error = undefined;
		this.callbacks.onChanged();
		try {
			await this.client?.prompt(text);
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
			messages: this.messages,
			automations: toUiAutomations(this.automations),
			activities: [...this.activities.values()].slice(-30),
			pendingRequest: this.pendingRequest,
			notice: this.notice,
			error: this.error,
		};
	}

	dispose(): void {
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
		const [state, messages, automations] = await Promise.all([
			client.getState(),
			client.getMessages(),
			client.listAutomations(true),
		]);
		this.state = state;
		this.messages = await toUiMessages(messages, this.folder.uri.fsPath);
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
			case "agent_settled":
				void this.refresh();
				return;
		}
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
