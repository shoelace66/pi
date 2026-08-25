import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeySecretKey } from "../src/api-key-secret.ts";

type MockHost = {
	stopCalls: number;
	started: boolean;
	blockStop(): void;
	releaseStop(): void;
};

const state = vi.hoisted(() => ({
	...(() => {
		const folder = {
			name: "workspace-a",
			uri: { fsPath: "C:\\workspace-a", toString: () => "file:///workspace-a" },
		};
		const folderB = {
			name: "workspace-b",
			uri: { fsPath: "C:\\workspace-b", toString: () => "file:///workspace-b" },
		};
		return {
			folder,
			folderB,
			folders: [folder] as Array<typeof folder>,
			hosts: [] as MockHost[],
			provider: "openrouter",
		};
	})(),
}));

vi.mock("vscode", () => ({
	workspace: {
		isTrusted: true,
		workspaceFolders: state.folders,
		onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
		onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: vi.fn() })),
		openTextDocument: vi.fn(),
		getConfiguration: vi.fn(() => ({
			get: (key: string, fallback: unknown) => (key === "provider" ? state.provider : fallback),
		})),
	},
	window: {
		activeTextEditor: undefined,
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	env: {
		clipboard: { writeText: vi.fn() },
		openExternal: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	ConfigurationTarget: {
		WorkspaceFolder: 5,
	},
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn((fsPath: string) => ({ fsPath, scheme: "file", toString: () => `file:///${fsPath}` })),
		parse: vi.fn((value: string) => ({ scheme: value.split(":", 1)[0] ?? "", toString: () => value })),
	},
}));

vi.mock("../src/backend-host.ts", () => ({
	WorkspaceBackendHost: class {
		readonly folder: unknown;
		stopCalls = 0;
		started = false;
		private stopResolver?: () => void;
		private stopPromise = Promise.resolve();

		constructor(folder: unknown) {
			this.folder = folder;
			state.hosts.push(this as unknown as MockHost);
		}

		async ensureStarted(): Promise<void> {
			this.started = true;
		}

		async newSession(): Promise<void> {}
		async refresh(): Promise<void> {}
		async abort(): Promise<void> {}
		async cancelAutomation(): Promise<void> {}

		getSnapshot(): { connection: "ready"; automations: [] } {
			return { connection: "ready", automations: [] };
		}

		stop(): Promise<void> {
			this.stopCalls++;
			return this.stopPromise;
		}

		blockStop(): void {
			this.stopPromise = new Promise((resolve) => {
				this.stopResolver = resolve;
			});
		}

		releaseStop(): void {
			this.stopResolver?.();
		}
	}
}));

import { AutoPiSidebarProvider } from "../src/sidebar-provider.ts";

function createContext() {
	const stored: Array<[string, string]> = [];
	const deleted: string[] = [];
	const context = {
		extensionUri: {},
		subscriptions: [],
		secrets: {
			get: vi.fn(),
			store: vi.fn(async (key: string, value: string) => {
				stored.push([key, value]);
			}),
			delete: vi.fn(async (key: string) => {
				deleted.push(key);
			}),
		},
	} as unknown as vscode.ExtensionContext;
	return { context, stored, deleted };
}

beforeEach(() => {
	vi.clearAllMocks();
	state.hosts.splice(0);
	state.folders.splice(0, state.folders.length, state.folder);
	state.provider = "openrouter";
});

describe("AutoPi sidebar host lifecycle", () => {
	it("waits for the old host to stop and coalesces a newer restart", async () => {
		const { context } = createContext();
		const provider = new AutoPiSidebarProvider(context);
		await provider.newSession();
		const oldHost = state.hosts[0];
		expect(oldHost).toBeDefined();
		oldHost!.blockStop();

		const firstRestart = provider.restartHosts();
		await vi.waitFor(() => expect(oldHost!.stopCalls).toBe(1));
		const secondRestart = provider.restartHosts();
		expect(state.hosts).toHaveLength(1);

		oldHost!.releaseStop();
		await Promise.all([firstRestart, secondRestart]);
		expect(state.hosts).toHaveLength(2);
		expect(state.hosts[1]?.started).toBe(true);
		await provider.stop();
	});

	it("stores the API key in the active workspace/provider scope", async () => {
		const { context, stored } = createContext();
		const provider = new AutoPiSidebarProvider(context);
		const scope = await provider.configureApiKey("secret-value");

		expect(scope).toEqual({ workspace: "workspace-a", provider: "openrouter" });
		expect(stored).toEqual([
			[apiKeySecretKey("file:///workspace-a", "openrouter"), "secret-value"],
		]);
		await provider.stop();
	});

	it("handles login as a local VS Code command instead of an agent prompt", async () => {
		const { context } = createContext();
		const provider = new AutoPiSidebarProvider(context);
		const handled = await (
			provider as unknown as { handleLocalSlashCommand(text: string): Promise<boolean> }
		).handleLocalSlashCommand("\\login");

		expect(handled).toBe(true);
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("autopi.configureApiKey");
		await provider.stop();
	});

	it("restarts only workspace hosts affected by a settings change", async () => {
		state.folders.push(state.folderB);
		const { context } = createContext();
		const provider = new AutoPiSidebarProvider(context);
		await provider.newSession();
		const hostA = state.hosts[0];
		(provider as unknown as { activeWorkspaceId: string }).activeWorkspaceId = state.folderB.uri.toString();
		await provider.newSession();
		const hostB = state.hosts[1];

		await provider.restartAffectedHosts({
			affectsConfiguration: (_section: string, scope?: vscode.Uri) => scope?.toString() === state.folderB.uri.toString(),
		} as vscode.ConfigurationChangeEvent);

		expect(hostA?.stopCalls).toBe(0);
		expect(hostB?.stopCalls).toBe(1);
		expect(state.hosts[2]?.started).toBe(true);
		await provider.stop();
	});

	it("opens PDFs externally instead of as text documents", async () => {
		const { context } = createContext();
		const provider = new AutoPiSidebarProvider(context);
		await provider.newSession();

		await (provider as unknown as { openFile(filePath: string): Promise<void> }).openFile("C:\\workspace-a\\report.pdf");

		expect(vscode.env.openExternal).toHaveBeenCalled();
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
		await provider.stop();
	});
});
