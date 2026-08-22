import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { RunTerminalRequest, SendInput } from "../shared/ipc-contract.ts";
import type { DesktopScopedModel } from "../shared/view-models.ts";
import { DesktopController } from "./ipc/desktop-controller.ts";
import { TerminalService } from "./services/terminal-service.ts";
import { listWorkspaceFiles, workspaceChanges } from "./services/workspace-capabilities.ts";

let window: BrowserWindow | undefined;
let controller: DesktopController | undefined;
let ipcRegistered = false;
const electronDirectory = dirname(fileURLToPath(import.meta.url));
const terminalService = new TerminalService();

type ProductBuildInfo = {
	productName: string;
	productVersion: string;
	coreVersion: string;
	buildId: string;
	sourceRevision: string;
};

function productBuildInfo(): ProductBuildInfo {
	const fallback = {
		productName: "AutoPi",
		productVersion: app.getVersion(),
		coreVersion: app.getVersion(),
		buildId: "development",
		sourceRevision: "unknown",
	};
	try {
		const path = join(app.getAppPath(), "dist", "build-info.json");
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProductBuildInfo>;
		return {
			productName: parsed.productName ?? fallback.productName,
			productVersion: parsed.productVersion ?? fallback.productVersion,
			coreVersion: parsed.coreVersion ?? fallback.coreVersion,
			buildId: parsed.buildId ?? fallback.buildId,
			sourceRevision: parsed.sourceRevision ?? fallback.sourceRevision,
		};
	} catch {
		return fallback;
	}
}

function canLaunchAtLogin(): boolean {
	return app.isPackaged && process.platform === "win32";
}

function launchAtLogin(): boolean {
	if (!canLaunchAtLogin()) return false;
	return app.getLoginItemSettings({ path: process.execPath, args: ["--autostart"] }).openAtLogin;
}

function workspaceDirectory(value: unknown): { valid: boolean; path: string; name: string } {
	if (typeof value !== "string" || !isAbsolute(value))
		return { valid: false, path: String(value ?? ""), name: "Unknown workspace" };
	const path = resolve(value);
	try {
		return { valid: statSync(path).isDirectory(), path, name: basename(path) || path };
	} catch {
		return { valid: false, path, name: basename(path) || path };
	}
}

function registerIpcHandlers(): void {
	if (ipcRegistered) return;
	ipcRegistered = true;
	ipcMain.handle("workspace:choose-directory", async () => {
		const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory", "createDirectory"] });
		if (result.canceled) return undefined;
		const selected = result.filePaths[0];
		const workspace = workspaceDirectory(selected);
		return workspace.valid ? workspace.path : undefined;
	});
	ipcMain.handle("workspace:validate-directory", (_event, value: unknown) => workspaceDirectory(value));
	ipcMain.handle("workspace:list-files", (_event, value: unknown) => {
		const workspace = workspaceDirectory(value);
		if (!workspace.valid) throw new Error("A valid workspace directory is required");
		return listWorkspaceFiles(workspace.path);
	});
	ipcMain.handle("workspace:changes", (_event, value: unknown) => {
		const workspace = workspaceDirectory(value);
		if (!workspace.valid) throw new Error("A valid workspace directory is required");
		return workspaceChanges(workspace.path);
	});
	ipcMain.handle("workspace:terminal", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("Terminal request is required");
		const value = args as Partial<RunTerminalRequest>;
		if (typeof value.executionId !== "string" || typeof value.cwd !== "string" || typeof value.command !== "string")
			throw new Error("Terminal execution id, cwd, and command are required");
		return terminalService.run(value as RunTerminalRequest);
	});
	ipcMain.handle("workspace:terminal-abort", (_event, executionId: unknown) =>
		terminalService.abort(String(executionId)),
	);
	// Every argument is validated again in Main; the Renderer receives no raw ipcRenderer.
	ipcMain.handle("desktop:get-snapshot", () => controller!.snapshot());
	ipcMain.handle("session:list", () => controller!.listSessions());
	ipcMain.handle("session:create", (_event, cwd: unknown) => {
		const workspace = workspaceDirectory(cwd);
		if (!workspace.valid) throw new Error("A valid workspace directory is required");
		return controller!.createSession(workspace.path);
	});
	ipcMain.handle("session:open", (_event, sessionId: unknown) => controller!.openSession(String(sessionId)));
	ipcMain.handle("session:delete", (_event, sessionId: unknown) => controller!.deleteSession(String(sessionId)));
	ipcMain.handle("session:slash-commands", (_event, sessionId: unknown) =>
		controller!.listSlashCommands(String(sessionId)),
	);
	ipcMain.handle("session:slash-command", (_event, args: unknown) => {
		if (
			!args ||
			typeof args !== "object" ||
			typeof (args as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (args as { command?: unknown }).command !== "string" ||
			((args as { args?: unknown }).args !== undefined && typeof (args as { args?: unknown }).args !== "string")
		)
			throw new Error("sessionId, command, and optional args are required");
		const value = args as { sessionId: string; command: string; args?: string };
		if (!/^[a-z0-9:_-]+$/i.test(value.command)) throw new Error("Invalid slash command name");
		return controller!.executeSlashCommand(value.sessionId, value.command, value.args ?? "");
	});
	ipcMain.handle("session:choose-file", async () => {
		const result = await dialog.showOpenDialog(window!, {
			properties: ["openFile"],
			filters: [{ name: "Pi session", extensions: ["jsonl"] }],
		});
		return result.canceled ? undefined : result.filePaths[0];
	});
	ipcMain.handle("session:choose-images", async () => {
		const result = await dialog.showOpenDialog(window!, {
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
		});
		return result.canceled ? [] : result.filePaths.slice(0, 5);
	});
	ipcMain.handle("session:import", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("session import is required");
		const value = args as { sessionId?: unknown; path?: unknown };
		if (typeof value.sessionId !== "string" || typeof value.path !== "string")
			throw new Error("sessionId and session path are required");
		return controller!.importSession(value.sessionId, value.path);
	});
	ipcMain.handle("session:fork", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("session fork is required");
		const value = args as { sessionId?: unknown; entryId?: unknown };
		if (typeof value.sessionId !== "string" || (value.entryId !== undefined && typeof value.entryId !== "string"))
			throw new Error("sessionId and optional entryId are required");
		return controller!.forkSession(value.sessionId, value.entryId as string | undefined);
	});
	ipcMain.handle("session:clone", (_event, sessionId: unknown) => controller!.cloneSession(String(sessionId)));
	ipcMain.handle("session:reload", (_event, sessionId: unknown) => controller!.reloadSession(String(sessionId)));
	ipcMain.handle("session:set-name", (_event, args: unknown) => {
		if (
			!args ||
			typeof args !== "object" ||
			typeof (args as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (args as { name?: unknown }).name !== "string"
		)
			throw new Error("sessionId and name are required");
		const value = args as { sessionId: string; name: string };
		return controller!.setSessionName(value.sessionId, value.name);
	});
	ipcMain.handle("session:set-mode", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("session mode request is required");
		const value = args as { sessionId?: unknown; mode?: unknown };
		if (typeof value.sessionId !== "string" || (value.mode !== "build" && value.mode !== "plan"))
			throw new Error("sessionId and a valid session mode are required");
		return controller!.setSessionMode(value.sessionId, value.mode);
	});
	ipcMain.handle("session:set-thinking-level", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("thinking level request is required");
		const value = args as { sessionId?: unknown; level?: unknown };
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
		if (
			typeof value.sessionId !== "string" ||
			typeof value.level !== "string" ||
			!levels.includes(value.level as (typeof levels)[number])
		)
			throw new Error("sessionId and a valid thinking level are required");
		return controller!.setThinkingLevel(value.sessionId, value.level as (typeof levels)[number]);
	});
	ipcMain.handle("session:compact", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("session compaction request is required");
		const value = args as { sessionId?: unknown; customInstructions?: unknown };
		if (
			typeof value.sessionId !== "string" ||
			(value.customInstructions !== undefined && typeof value.customInstructions !== "string")
		)
			throw new Error("sessionId and optional compaction instructions are required");
		return controller!.compactSession(value.sessionId, value.customInstructions as string | undefined);
	});
	ipcMain.handle("session:stats", (_event, sessionId: unknown) => controller!.getSessionStats(String(sessionId)));
	ipcMain.handle("session:share", (_event, sessionId: unknown) => controller!.shareSession(String(sessionId)));
	ipcMain.handle("session:export", (_event, args: unknown) => {
		if (
			!args ||
			typeof args !== "object" ||
			typeof (args as { sessionId?: unknown }).sessionId !== "string" ||
			((args as { format?: unknown }).format !== undefined &&
				(args as { format?: unknown }).format !== "html" &&
				(args as { format?: unknown }).format !== "jsonl") ||
			((args as { outputPath?: unknown }).outputPath !== undefined &&
				typeof (args as { outputPath?: unknown }).outputPath !== "string")
		)
			throw new Error("sessionId, a valid export format, and optional output path are required");
		const value = args as { sessionId: string; format?: "html" | "jsonl"; outputPath?: string };
		return controller!.exportSession(value.sessionId, value.format ?? "html", value.outputPath);
	});
	ipcMain.handle("session:tree", (_event, sessionId: unknown) => controller!.getSessionTree(String(sessionId)));
	ipcMain.handle("session:tree-navigate", (_event, args: unknown) => {
		if (
			!args ||
			typeof args !== "object" ||
			typeof (args as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (args as { targetId?: unknown }).targetId !== "string"
		)
			throw new Error("sessionId and targetId are required");
		const value = args as { sessionId: string; targetId: string };
		return controller!.navigateSessionTree(value.sessionId, value.targetId);
	});
	ipcMain.handle("model:list", (_event, sessionId: unknown) => controller!.listModels(String(sessionId)));
	ipcMain.handle("model:set", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("model selection is required");
		const value = args as { sessionId?: unknown; provider?: unknown; modelId?: unknown };
		if (
			typeof value.sessionId !== "string" ||
			typeof value.provider !== "string" ||
			typeof value.modelId !== "string"
		) {
			throw new Error("sessionId, provider, and modelId are required");
		}
		return controller!.selectModel(value.sessionId, value.provider, value.modelId);
	});
	ipcMain.handle("model:scope-get", (_event, sessionId: unknown) => controller!.getScopedModels(String(sessionId)));
	ipcMain.handle("model:scope-set", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("model scope is required");
		const value = args as { sessionId?: unknown; models?: unknown };
		if (typeof value.sessionId !== "string" || !Array.isArray(value.models))
			throw new Error("sessionId and models are required");
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const model of value.models) {
			if (
				!model ||
				typeof model !== "object" ||
				typeof (model as { provider?: unknown }).provider !== "string" ||
				typeof (model as { modelId?: unknown }).modelId !== "string" ||
				((model as { thinkingLevel?: unknown }).thinkingLevel !== undefined &&
					!levels.includes(String((model as { thinkingLevel?: unknown }).thinkingLevel)))
			)
				throw new Error("Every scoped model requires a provider, modelId, and optional thinking level");
		}
		return controller!.setScopedModels(value.sessionId, value.models as DesktopScopedModel[]);
	});
	ipcMain.handle("models-providers:get", (_event, sessionId: unknown) =>
		controller!.getModelsProviders(String(sessionId)),
	);
	ipcMain.handle("models-providers:refresh", (_event, sessionId: unknown) =>
		controller!.refreshModelsProviders(String(sessionId)),
	);
	ipcMain.handle("models-providers:set-api-key", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("provider credentials are required");
		const value = args as { sessionId?: unknown; provider?: unknown; apiKey?: unknown };
		if (
			typeof value.sessionId !== "string" ||
			typeof value.provider !== "string" ||
			typeof value.apiKey !== "string"
		) {
			throw new Error("sessionId, provider, and apiKey are required");
		}
		return controller!.setProviderApiKey(value.sessionId, value.provider, value.apiKey);
	});
	ipcMain.handle("models-providers:remove-api-key", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("provider credentials are required");
		const value = args as { sessionId?: unknown; provider?: unknown };
		if (typeof value.sessionId !== "string" || typeof value.provider !== "string") {
			throw new Error("sessionId and provider are required");
		}
		return controller!.removeProviderApiKey(value.sessionId, value.provider);
	});
	for (const [channel, action] of [
		["models-providers:login", "login"],
		["models-providers:logout", "logout"],
	] as const) {
		ipcMain.handle(channel, (_event, args: unknown) => {
			if (!args || typeof args !== "object") throw new Error("provider authentication request is required");
			const value = args as { sessionId?: unknown; provider?: unknown };
			if (typeof value.sessionId !== "string" || typeof value.provider !== "string")
				throw new Error("sessionId and provider are required");
			return action === "login"
				? controller!.loginProvider(value.sessionId, value.provider)
				: controller!.logoutProvider(value.sessionId, value.provider);
		});
	}
	ipcMain.handle("session:set-project-trust", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("project trust is required");
		const value = args as { sessionId?: unknown; trusted?: unknown };
		if (typeof value.sessionId !== "string" || typeof value.trusted !== "boolean")
			throw new Error("sessionId and trusted are required");
		return controller!.setProjectTrust(value.sessionId, value.trusted);
	});
	ipcMain.handle("app:quit", () => {
		app.quit();
	});
	ipcMain.handle("session:send-input", (_event, input: unknown) => {
		if (!input || typeof input !== "object") throw new Error("input is required");
		const value = input as Partial<SendInput>;
		if (
			typeof value.sessionId !== "string" ||
			typeof value.text !== "string" ||
			typeof value.clientMessageId !== "string"
		)
			throw new Error("sessionId, text, and clientMessageId are required");
		if (value.deliveryMode !== undefined && value.deliveryMode !== "on_trigger" && value.deliveryMode !== "wake_now")
			throw new Error("invalid deliveryMode");
		if (
			value.imagePaths !== undefined &&
			(!Array.isArray(value.imagePaths) ||
				value.imagePaths.length > 5 ||
				!value.imagePaths.every((path) => typeof path === "string" && isAbsolute(path)))
		)
			throw new Error("imagePaths must contain at most five absolute paths");
		if (
			value.streamingBehavior !== undefined &&
			value.streamingBehavior !== "steer" &&
			value.streamingBehavior !== "followUp"
		)
			throw new Error("invalid streamingBehavior");
		return controller!.sendInput(value as SendInput);
	});
	ipcMain.handle("session:abort", (_event, sessionId: unknown) => controller!.abortSession(String(sessionId)));
	ipcMain.handle("session:bash", (_event, args: unknown) => {
		if (!args || typeof args !== "object") throw new Error("session command request is required");
		const value = args as { sessionId?: unknown; command?: unknown; excludeFromContext?: unknown };
		if (
			typeof value.sessionId !== "string" ||
			typeof value.command !== "string" ||
			(value.excludeFromContext !== undefined && typeof value.excludeFromContext !== "boolean")
		)
			throw new Error("sessionId, command, and optional context exclusion are required");
		return controller!.runSessionCommand(value.sessionId, value.command, value.excludeFromContext === true);
	});
	ipcMain.handle("wake:cancel", (_event, args: unknown) => {
		if (
			!args ||
			typeof args !== "object" ||
			typeof (args as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (args as { wakeId?: unknown }).wakeId !== "string"
		)
			throw new Error("sessionId and wakeId are required");
		const value = args as { sessionId: string; wakeId: string };
		return controller!.cancelWake(value.sessionId, value.wakeId);
	});
	ipcMain.handle("wake:get-inbox", (_event, wakeId: unknown) => controller!.getInbox(String(wakeId)));
	ipcMain.handle("wake:create", (_event, sessionId: unknown, request: unknown) => {
		if (!request || typeof request !== "object") throw new Error("wake request is required");
		return controller!.createWake(String(sessionId), request as never);
	});
	ipcMain.handle("wake:list", (_event, sessionId: unknown, includeTerminal: unknown) =>
		controller!.listWakeups(String(sessionId), includeTerminal === true),
	);
	ipcMain.handle("monitor:list", () => controller!.getMonitorAdapters());
	ipcMain.handle("extension-ui:respond", (_event, response: unknown) => {
		if (!response || typeof response !== "object") throw new Error("extension UI response is required");
		const value = response as { requestId?: unknown; outcome?: unknown; value?: unknown };
		if (typeof value.requestId !== "string") throw new Error("requestId is required");
		const outcomes = ["selected", "confirmed", "entered", "cancelled"];
		if (typeof value.outcome !== "string" || !outcomes.includes(value.outcome))
			throw new Error("a valid extension UI outcome is required");
		if (value.outcome === "confirmed") {
			if (typeof value.value !== "boolean") throw new Error("confirmed responses require a boolean value");
			return controller!.respondToExtensionUI({
				requestId: value.requestId,
				outcome: "confirmed",
				value: value.value,
			});
		}
		if (value.outcome === "cancelled")
			return controller!.respondToExtensionUI({ requestId: value.requestId, outcome: "cancelled" });
		if (typeof value.value !== "string") throw new Error("selected and entered responses require a string value");
		return controller!.respondToExtensionUI({
			requestId: value.requestId,
			outcome: value.outcome as "selected" | "entered",
			value: value.value,
		});
	});
	ipcMain.handle("desktop:get-settings", () => ({
		...controller!.getSettings(),
		...productBuildInfo(),
		canLaunchAtLogin: canLaunchAtLogin(),
		launchAtLogin: launchAtLogin(),
	}));
	ipcMain.handle("desktop:set-launch-at-login", (_event, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new Error("Auto-start setting must be a boolean");
		if (!canLaunchAtLogin()) throw new Error("Auto-start is available in packaged Windows builds only");
		app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ["--autostart"] });
		return launchAtLogin();
	});
	ipcMain.handle("window:set-theme", (_event, theme: unknown) => {
		if (theme !== "dark" && theme !== "light") throw new Error("Window theme must be dark or light");
		if (process.platform === "win32") {
			window?.setTitleBarOverlay({
				color: "#00000000",
				symbolColor: theme === "dark" ? "#F4FBFF" : "#161B3C",
				height: 52,
			});
		}
	});
	ipcMain.handle("desktop:get-changelog", () => controller!.getChangelog());
	ipcMain.handle("desktop:open-external", async (_event, url: unknown) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Only HTTP(S) URLs are allowed");
		await shell.openExternal(url);
	});
}

async function createWindow(): Promise<void> {
	const preloadPath = join(electronDirectory, "preload.cjs");
	if (!existsSync(preloadPath)) throw new Error(`Electron preload was not built: ${preloadPath}`);
	const iconPath = app.isPackaged
		? join(process.resourcesPath, "autopi-ap-symbol-1024.png")
		: resolve(electronDirectory, "..", "..", "..", "..", "autopi-ap-symbol-1024.png");
	window = new BrowserWindow({
		title: "AutoPi",
		icon: existsSync(iconPath) ? iconPath : undefined,
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#00000000", symbolColor: "#F4FBFF", height: 52 },
		backgroundColor: "#090D20",
		show: false,
		width: 1440,
		height: 920,
		minWidth: 1050,
		minHeight: 680,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath },
	});
	controller = new DesktopController({
		window,
		cwd: process.cwd(),
		dataDirectory: join(app.getPath("userData"), "pi"),
	});
	registerIpcHandlers();
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const currentUrl = window?.webContents.getURL();
		if (url === currentUrl) return;
		event.preventDefault();
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
	});
	const rendererUrl =
		process.env.PI_DESKTOP_DEV_URL ?? (process.argv.includes("--dev") ? "http://localhost:5173" : undefined);
	window.once("ready-to-show", () => window?.show());
	if (rendererUrl) await window.loadURL(rendererUrl);
	else await window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
	window.on("closed", () => {
		window = undefined;
	});
}

app.setName("AutoPi");
if (process.platform === "win32") app.setAppUserModelId("com.autopi.desktop");

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
else {
	app.on("second-instance", () => {
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	});
	app.whenReady()
		.then(async () => {
			Menu.setApplicationMenu(null);
			if (!window) await createWindow();
		})
		.catch((reason) => {
			console.error("Failed to start AutoPi", reason);
			app.quit();
		});
}

app.on("activate", () => {
	if (!window) void createWindow();
});

app.on("before-quit", async (event) => {
	if (!controller) return;
	event.preventDefault();
	const current = controller;
	controller = undefined;
	await current.dispose();
	app.exit(0);
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
