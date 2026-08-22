import type {
	CreateWakeRequest,
	DesktopApi,
	DesktopEvent,
	RunTerminalRequest,
	SendInput,
} from "../shared/ipc-contract.ts";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
	chooseWorkspaceDirectory: () => ipcRenderer.invoke("workspace:choose-directory"),
	validateWorkspaceDirectory: (path) => ipcRenderer.invoke("workspace:validate-directory", path),
	getSnapshot: () => ipcRenderer.invoke("desktop:get-snapshot"),
	listSessions: () => ipcRenderer.invoke("session:list"),
	createSession: (cwd) => ipcRenderer.invoke("session:create", cwd),
	openSession: (sessionId) => ipcRenderer.invoke("session:open", sessionId),
	deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
	listModels: (sessionId) => ipcRenderer.invoke("model:list", sessionId),
	selectModel: (sessionId, provider, modelId) => ipcRenderer.invoke("model:set", { sessionId, provider, modelId }),
	getScopedModels: (sessionId) => ipcRenderer.invoke("model:scope-get", sessionId),
	setScopedModels: (sessionId, models) => ipcRenderer.invoke("model:scope-set", { sessionId, models }),
	getModelsProviders: (sessionId) => ipcRenderer.invoke("models-providers:get", sessionId),
	refreshModelsProviders: (sessionId) => ipcRenderer.invoke("models-providers:refresh", sessionId),
	setProviderApiKey: (sessionId, provider, apiKey) =>
		ipcRenderer.invoke("models-providers:set-api-key", { sessionId, provider, apiKey }),
	removeProviderApiKey: (sessionId, provider) =>
		ipcRenderer.invoke("models-providers:remove-api-key", { sessionId, provider }),
	loginProvider: (sessionId, provider) => ipcRenderer.invoke("models-providers:login", { sessionId, provider }),
	logoutProvider: (sessionId, provider) => ipcRenderer.invoke("models-providers:logout", { sessionId, provider }),
	setProjectTrust: (sessionId, trusted) => ipcRenderer.invoke("session:set-project-trust", { sessionId, trusted }),
	quit: () => ipcRenderer.invoke("app:quit"),
	listSlashCommands: (sessionId) => ipcRenderer.invoke("session:slash-commands", sessionId),
	executeSlashCommand: (sessionId, command, args = "") =>
		ipcRenderer.invoke("session:slash-command", { sessionId, command, args }),
	chooseSessionFile: () => ipcRenderer.invoke("session:choose-file"),
	chooseImageFiles: () => ipcRenderer.invoke("session:choose-images"),
	importSession: (sessionId, path) => ipcRenderer.invoke("session:import", { sessionId, path }),
	forkSession: (sessionId, entryId) => ipcRenderer.invoke("session:fork", { sessionId, entryId }),
	cloneSession: (sessionId) => ipcRenderer.invoke("session:clone", sessionId),
	reloadSession: (sessionId) => ipcRenderer.invoke("session:reload", sessionId),
	setSessionName: (sessionId, name) => ipcRenderer.invoke("session:set-name", { sessionId, name }),
	setSessionMode: (sessionId, mode) => ipcRenderer.invoke("session:set-mode", { sessionId, mode }),
	setThinkingLevel: (sessionId, level) => ipcRenderer.invoke("session:set-thinking-level", { sessionId, level }),
	compactSession: (sessionId, customInstructions) =>
		ipcRenderer.invoke("session:compact", { sessionId, customInstructions }),
	getSessionStats: (sessionId) => ipcRenderer.invoke("session:stats", sessionId),
	shareSession: (sessionId) => ipcRenderer.invoke("session:share", sessionId),
	exportSession: (sessionId, format = "html", outputPath) =>
		ipcRenderer.invoke("session:export", { sessionId, format, outputPath }),
	getSessionTree: (sessionId) => ipcRenderer.invoke("session:tree", sessionId),
	navigateSessionTree: (sessionId, targetId) => ipcRenderer.invoke("session:tree-navigate", { sessionId, targetId }),
	sendInput: (input: SendInput) => ipcRenderer.invoke("session:send-input", input),
	abortSession: (sessionId) => ipcRenderer.invoke("session:abort", sessionId),
	cancelWake: (sessionId, wakeId) => ipcRenderer.invoke("wake:cancel", { sessionId, wakeId }),
	getInbox: (wakeId) => ipcRenderer.invoke("wake:get-inbox", wakeId),
	createWake: (sessionId, request: CreateWakeRequest) => ipcRenderer.invoke("wake:create", sessionId, request),
	listWakeups: (sessionId, includeTerminal = false) => ipcRenderer.invoke("wake:list", sessionId, includeTerminal),
	getMonitorAdapters: () => ipcRenderer.invoke("monitor:list"),
	respondToExtensionUI: (response) => ipcRenderer.invoke("extension-ui:respond", response),
	getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
	setLaunchAtLogin: (enabled) => ipcRenderer.invoke("desktop:set-launch-at-login", enabled),
	setWindowTheme: (theme) => ipcRenderer.invoke("window:set-theme", theme),
	getChangelog: () => ipcRenderer.invoke("desktop:get-changelog"),
	listWorkspaceFiles: (path) => ipcRenderer.invoke("workspace:list-files", path),
	getWorkspaceChanges: (path) => ipcRenderer.invoke("workspace:changes", path),
	runTerminalCommand: (request: RunTerminalRequest) => ipcRenderer.invoke("workspace:terminal", request),
	abortTerminalCommand: (executionId) => ipcRenderer.invoke("workspace:terminal-abort", executionId),
	runSessionCommand: (sessionId, command, excludeFromContext = false) =>
		ipcRenderer.invoke("session:bash", { sessionId, command, excludeFromContext }),
	openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
	onEvent: (listener: (event: DesktopEvent) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload);
		ipcRenderer.on("desktop:event", handler);
		return () => ipcRenderer.removeListener("desktop:event", handler);
	},
};

contextBridge.exposeInMainWorld("piDesktop", api);
