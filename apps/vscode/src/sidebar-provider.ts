import path from "node:path";
import * as vscode from "vscode";
import type { HostToWebviewMessage, ViewSnapshot, WebviewToHostMessage, WorkspaceOption } from "../shared/protocol.ts";
import { isWebviewToHostMessage } from "../shared/protocol.ts";
import { apiKeyProviderLabel, apiKeySecretKey } from "./api-key-secret.ts";
import { WorkspaceBackendHost } from "./backend-host.ts";

export class AutoPiSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = "autopi.sidebar";

	private readonly context: vscode.ExtensionContext;
	private view?: vscode.WebviewView;
	private readonly hosts = new Map<string, WorkspaceBackendHost>();
	private activeWorkspaceId?: string;
	private disposed = false;
	private stopPromise?: Promise<void>;
	private restartPromise: Promise<void> = Promise.resolve();
	private restartGeneration = 0;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.activeWorkspaceId = this.workspaceOptions()[0]?.id;
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.workspaceFoldersChanged()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				void this.startActiveHost();
			}),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"),
				vscode.Uri.joinPath(this.context.extensionUri, "media"),
			],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((value: unknown) => {
			if (isWebviewToHostMessage(value)) void this.handleMessage(value);
		});
		void this.postSnapshot();
	}

	async newSession(): Promise<void> {
		const host = await this.activeHost(true);
		await host?.newSession();
		await this.postSnapshot();
	}

	async refresh(): Promise<void> {
		const host = await this.activeHost(false);
		await host?.refresh();
		await this.postSnapshot();
	}

	async configureApiKey(apiKey: string): Promise<{ workspace: string; provider: string }> {
		const folder = this.activeFolder();
		if (!folder) throw new Error("请先在 VS Code 中打开一个项目文件夹。");
		const provider = vscode.workspace.getConfiguration("autopi", folder.uri).get<string>("provider", "").trim();
		const key = apiKeySecretKey(folder.uri.toString(), provider || undefined);
		if (apiKey) await this.context.secrets.store(key, apiKey);
		else await this.context.secrets.delete(key);
		await this.restartHosts();
		return { workspace: folder.name, provider: apiKeyProviderLabel(provider || undefined) };
	}

	restartHosts(): Promise<void> {
		const generation = ++this.restartGeneration;
		const restart = this.restartPromise.then(async () => {
			if (this.disposed || generation !== this.restartGeneration) return;
			const hosts = [...this.hosts.values()];
			this.hosts.clear();
			await Promise.allSettled(hosts.map((host) => host.stop()));
			if (this.disposed || generation !== this.restartGeneration) return;
			await this.startActiveHost();
		});
		this.restartPromise = restart.catch(() => undefined);
		return restart;
	}

	dispose(): void {
		void this.stop();
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.disposed = true;
		const hosts = [...this.hosts.values()];
		this.hosts.clear();
		this.stopPromise = Promise.allSettled([this.restartPromise, ...hosts.map((host) => host.stop())]).then(
			() => undefined,
		);
		return this.stopPromise;
	}

	private async handleMessage(message: WebviewToHostMessage): Promise<void> {
		try {
			switch (message.type) {
				case "ready":
					await this.startActiveHost();
					break;
				case "select_workspace":
					if (this.workspaceOptions().some((workspace) => workspace.id === message.workspaceId)) {
						this.activeWorkspaceId = message.workspaceId;
						await this.startActiveHost();
					}
					break;
				case "prompt": {
					const host = await this.activeHost(true);
					if (!host) throw new Error("请先在 VS Code 中打开一个项目文件夹。");
					const prompt = message.includeEditorContext ? this.withEditorContext(message.text, host.folder) : message.text;
					await host.prompt(prompt);
					break;
				}
				case "abort":
					await (await this.activeHost(false))?.abort();
					break;
				case "new_session":
					await this.newSession();
					break;
				case "refresh":
					await this.refresh();
					break;
				case "cancel_automation":
					await (await this.activeHost(true))?.cancelAutomation(message.automationId);
					break;
				case "open_file":
					await this.openFile(message.path);
					break;
				case "respond_ui":
					this.respondToUi(message);
					break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`AutoPi: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			await this.postSnapshot();
		}
	}

	private async startActiveHost(): Promise<void> {
		if (this.disposed) return;
		if (!vscode.workspace.isTrusted) {
			await this.postSnapshot();
			return;
		}
		const host = await this.activeHost(true);
		try {
			await host?.ensureStarted();
		} catch {
			// The host snapshot already contains the actionable startup error.
		}
		await this.postSnapshot();
	}

	private async activeHost(create: boolean): Promise<WorkspaceBackendHost | undefined> {
		if (this.disposed) return undefined;
		const folder = this.activeFolder();
		if (!folder) return undefined;
		const key = folder.uri.toString();
		const existing = this.hosts.get(key);
		if (existing || !create) return existing;
		const host = new WorkspaceBackendHost(folder, this.context, {
			onChanged: () => void this.postSnapshot(),
			onComposerText: (text) => this.post({ type: "set_composer", text }),
		});
		this.hosts.set(key, host);
		return host;
	}

	private activeFolder(): vscode.WorkspaceFolder | undefined {
		const folders = vscode.workspace.workspaceFolders ?? [];
		return folders.find((folder) => folder.uri.toString() === this.activeWorkspaceId) ?? folders[0];
	}

	private workspaceOptions(): WorkspaceOption[] {
		return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
			id: folder.uri.toString(),
			name: folder.name,
			path: folder.uri.fsPath,
		}));
	}

	private workspaceFoldersChanged(): void {
		const current = new Set(this.workspaceOptions().map((workspace) => workspace.id));
		for (const [id, host] of this.hosts) {
			if (!current.has(id)) {
				void host.stop();
				this.hosts.delete(id);
			}
		}
		if (!this.activeWorkspaceId || !current.has(this.activeWorkspaceId)) {
			this.activeWorkspaceId = this.workspaceOptions()[0]?.id;
		}
		void this.startActiveHost();
	}

	private withEditorContext(prompt: string, folder: vscode.WorkspaceFolder): string {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return prompt;
		const owner = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (owner?.uri.toString() !== folder.uri.toString()) return prompt;
		const relativePath = path.relative(folder.uri.fsPath, editor.document.uri.fsPath);
		const selection = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection);
		const context = selection
			? `当前选区来自 ${relativePath}:\n\n\`\`\`\n${selection}\n\`\`\``
			: `当前编辑器文件：${relativePath}`;
		return `${prompt}\n\n<vscode_context>\n${context}\n</vscode_context>`;
	}

	private async openFile(requestedPath: string): Promise<void> {
		const host = await this.activeHost(false);
		const workspacePath = host?.folder.uri.fsPath ?? this.activeFolder()?.uri.fsPath;
		if (!workspacePath) throw new Error("没有活动工作区。");
		const absolute = path.resolve(requestedPath);
		const workspaceRelative = path.relative(workspacePath, absolute);
		const insideWorkspace =
			workspaceRelative === "" ||
			(!workspaceRelative.startsWith(`..${path.sep}`) && workspaceRelative !== ".." && !path.isAbsolute(workspaceRelative));
		const allowedLog = host?.getSnapshot().automations.some((automation) => automation.logPath === absolute) ?? false;
		if (!insideWorkspace && !allowedLog) throw new Error("拒绝打开工作区和 AutoPi 日志目录之外的文件。");
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
		await vscode.window.showTextDocument(document, { preview: false });
	}

	private respondToUi(message: Extract<WebviewToHostMessage, { type: "respond_ui" }>): void {
		void this.activeHost(false).then((host) => {
			const request = host?.getSnapshot().pendingRequest;
			if (!host || request?.id !== message.requestId) return;
			if (message.cancelled) {
				host.respondToUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			} else if (request.method === "confirm") {
				host.respondToUi({ type: "extension_ui_response", id: request.id, confirmed: message.confirmed === true });
			} else {
				host.respondToUi({ type: "extension_ui_response", id: request.id, value: message.value ?? "" });
			}
		});
	}

	private async postSnapshot(): Promise<void> {
		const workspaces = this.workspaceOptions();
		const active = this.activeFolder();
		const host = active ? this.hosts.get(active.uri.toString()) : undefined;
		const backend = host?.getSnapshot();
		const snapshot: ViewSnapshot = {
			trusted: vscode.workspace.isTrusted,
			workspaces,
			activeWorkspaceId: active?.uri.toString(),
			connection: vscode.workspace.isTrusted ? (backend?.connection ?? "starting") : "view_only",
			model: backend?.model ?? "默认模型",
			sessionName: backend?.sessionName ?? active?.name ?? "未打开工作区",
			messages: backend?.messages ?? [],
			activities: backend?.activities ?? [],
			automations: backend?.automations ?? [],
			pendingRequest: backend?.pendingRequest,
			notice: backend?.notice,
			error: backend?.error,
		};
		this.post({ type: "snapshot", snapshot });
	}

	private post(message: HostToWebviewMessage): void {
		void this.view?.webview.postMessage(message);
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "styles.css"));
		const emptyWordmark = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, "media", "wordmark-ice.svg"),
		);
		return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
	<title>AutoPi</title>
</head>
<body data-empty-wordmark="${emptyWordmark}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from({ length: 32 }, () => alphabet.charAt(Math.floor(Math.random() * alphabet.length))).join("");
}
