import path from "node:path";
import * as vscode from "vscode";
import type { HostToWebviewMessage, ViewSnapshot, WebviewToHostMessage, WorkspaceOption } from "../shared/protocol.ts";
import { isWebviewToHostMessage } from "../shared/protocol.ts";
import { apiKeyProviderLabel, apiKeySecretKey } from "./api-key-secret.ts";
import { WorkspaceBackendHost } from "./backend-host.ts";

const imageExtensions = new Set([".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const textExtensions = new Set([
	".bash",
	".c",
	".cc",
	".cpp",
	".cs",
	".css",
	".csv",
	".cxx",
	".dart",
	".go",
	".h",
	".hpp",
	".htm",
	".html",
	".java",
	".js",
	".json",
	".jsonl",
	".jsx",
	".kt",
	".kts",
	".less",
	".log",
	".md",
	".mjs",
	".php",
	".ps1",
	".py",
	".rb",
	".rs",
	".scss",
	".sh",
	".sql",
	".svelte",
	".swift",
	".toml",
	".ts",
	".tsv",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
	".zsh",
]);

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
		await this.restartFoldersWithConfirmation([folder]);
		return { workspace: folder.name, provider: apiKeyProviderLabel(provider || undefined) };
	}

	restartHosts(workspaceIds?: readonly string[]): Promise<void> {
		const generation = ++this.restartGeneration;
		const targets = workspaceIds ? new Set(workspaceIds) : new Set(this.workspaceOptions().map((workspace) => workspace.id));
		const restart = this.restartPromise.then(async () => {
			if (this.disposed || generation !== this.restartGeneration) return;
			const hosts = [...this.hosts].filter(([id]) => targets.has(id));
			for (const [id] of hosts) this.hosts.delete(id);
			await Promise.allSettled(hosts.map(([, host]) => host.stop()));
			if (this.disposed || generation !== this.restartGeneration) return;
			const activeId = this.activeFolder()?.uri.toString();
			if (activeId && targets.has(activeId)) await this.startActiveHost();
		});
		this.restartPromise = restart.catch(() => undefined);
		return restart;
	}

	async restartAffectedHosts(event: vscode.ConfigurationChangeEvent): Promise<void> {
		const affected = (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
			event.affectsConfiguration("autopi", folder.uri),
		);
		if (affected.length === 0) return;
		await this.restartFoldersWithConfirmation(affected);
	}

	private async restartFoldersWithConfirmation(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
		const running = folders.filter(
			(folder) => this.hosts.get(folder.uri.toString())?.getSnapshot().connection === "running",
		);
		if (running.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`AutoPi 设置已更改，但 ${running.map((folder) => folder.name).join("、")} 仍在执行任务。是否立即重启受影响的后端？`,
				"立即重启",
				"暂不重启",
			);
			if (choice !== "立即重启") return;
		}
		await this.restartHosts(folders.map((folder) => folder.uri.toString()));
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
					if (await this.handleLocalSlashCommand(message.text)) break;
					const host = await this.activeHost(true);
					if (!host) throw new Error("请先在 VS Code 中打开一个项目文件夹。");
					const prompt =
						message.includeEditorContext && !/^[\\/]/.test(message.text.trimStart())
							? this.withEditorContext(message.text, host.folder)
							: message.text;
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
				case "retry":
					await this.startActiveHost();
					break;
				case "configure_api_key":
					await vscode.commands.executeCommand("autopi.configureApiKey");
					break;
				case "open_settings":
					await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:shoelace66.autopi");
					break;
				case "copy_text":
					await vscode.env.clipboard.writeText(message.text);
					break;
				case "open_external":
					await this.openExternal(message.url);
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

	private async handleLocalSlashCommand(text: string): Promise<boolean> {
		const match = /^[\\/](login|logout)(?:\s+([^\s]+))?\s*$/i.exec(text.trim());
		if (!match) return false;
		const provider = match[2]?.trim();
		if (provider) {
			const folder = this.activeFolder();
			if (!folder) throw new Error("请先在 VS Code 中打开一个项目文件夹。");
			await vscode.workspace
				.getConfiguration("autopi", folder.uri)
				.update("provider", provider, vscode.ConfigurationTarget.WorkspaceFolder);
		}
		if (match[1]?.toLowerCase() === "login") {
			await vscode.commands.executeCommand("autopi.configureApiKey");
			return true;
		}
		const scope = await this.configureApiKey("");
		void vscode.window.showInformationMessage(`AutoPi API 密钥已删除（${scope.workspace} / ${scope.provider}）。`);
		return true;
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
		const uri = vscode.Uri.file(absolute);
		const extension = path.extname(absolute).toLowerCase();
		if (extension === ".pdf") {
			await vscode.env.openExternal(uri);
			return;
		}
		if (imageExtensions.has(extension) || extension === ".ipynb") {
			await vscode.commands.executeCommand("vscode.open", uri);
			return;
		}
		if (textExtensions.has(extension)) {
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, { preview: false });
			return;
		}
		await vscode.commands.executeCommand("vscode.open", uri);
	}

	private async openExternal(rawUrl: string): Promise<void> {
		const uri = vscode.Uri.parse(rawUrl);
		if (!new Set(["http", "https", "mailto"]).has(uri.scheme.toLowerCase())) {
			throw new Error("只允许打开 HTTP、HTTPS 或邮件链接。");
		}
		await vscode.env.openExternal(uri);
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
			commands: backend?.commands ?? [],
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
