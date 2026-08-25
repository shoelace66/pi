import path from "node:path";
import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockRpcClient = {
	stopped: boolean;
};

const rpcState = vi.hoisted(() => ({
	clients: [] as MockRpcClient[],
	refreshFailures: 0,
	prompts: [] as string[],
	models: [] as Array<[string, string]>,
	resumedSessions: [] as string[],
}));

vi.mock("vscode", () => ({
	workspace: {
		isTrusted: true,
		getConfiguration: vi.fn(() => ({
			get: (key: string, fallback: unknown) => (key === "backendPath" ? "backend.js" : fallback),
		})),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showQuickPick: vi.fn(async (items: unknown[]) => items[0]),
	},
}));

vi.mock("../../../packages/coding-agent/src/modes/rpc/rpc-client.ts", () => ({
	RpcClient: class {
		stopped = false;

		constructor() {
			rpcState.clients.push(this);
		}

		onEvent(): void {}
		onProtocolEvent(): void {}

		async start(): Promise<void> {}

		async stop(): Promise<void> {
			this.stopped = true;
		}

		async getState(): Promise<{ isStreaming: boolean }> {
			if (rpcState.refreshFailures > 0) {
				rpcState.refreshFailures--;
				throw new Error("initial refresh failed");
			}
			return { isStreaming: false };
		}

		async getMessages(): Promise<[]> {
			return [];
		}

		async listAutomations(): Promise<[]> {
			return [];
		}

		async getCommands(): Promise<[]> {
			return [];
		}

		async prompt(message: string): Promise<void> {
			rpcState.prompts.push(message);
		}

		async setModel(provider: string, model: string): Promise<void> {
			rpcState.models.push([provider, model]);
		}

		async listSessions(): Promise<Array<Record<string, unknown>>> {
			return [
				{
					path: "D:\\sessions\\previous.jsonl",
					id: "previous",
					cwd: "D:\\workspace",
					name: "Previous session",
					created: "2026-08-24T00:00:00.000Z",
					modified: "2026-08-25T00:00:00.000Z",
					messageCount: 4,
					firstMessage: "Continue the task",
				},
			];
		}

		async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
			rpcState.resumedSessions.push(sessionPath);
			return { cancelled: false };
		}
	},
}));

import { WorkspaceBackendHost } from "../src/backend-host.ts";

type BackendHostInternals = {
	resolveBackend(configuredPath: string): { executablePath?: string; cliPath?: string };
	handleAgentEvent(event: unknown): void;
};

function createHost(onChanged = vi.fn()): { host: WorkspaceBackendHost; onChanged: ReturnType<typeof vi.fn> } {
	const folder = {
		name: "workspace",
		uri: { fsPath: path.resolve("workspace"), toString: () => "file:///workspace" },
	} as unknown as vscode.WorkspaceFolder;
	const context = { secrets: { get: vi.fn() } } as unknown as vscode.ExtensionContext;
	return {
		host: new WorkspaceBackendHost(folder, context, { onChanged, onComposerText: vi.fn() }),
		onChanged,
	};
}

beforeEach(() => {
	rpcState.clients.splice(0);
	rpcState.refreshFailures = 0;
	rpcState.prompts.splice(0);
	rpcState.models.splice(0);
	rpcState.resumedSessions.splice(0);
});

describe("VS Code backend host quality behavior", () => {
	it.each(["backend.js", "backend.mjs", "backend.cjs", "BACKEND.MJS"])(
		"launches %s through Node",
		(configuredPath) => {
			const { host } = createHost();
			const launch = (host as unknown as BackendHostInternals).resolveBackend(configuredPath);
			expect(launch.cliPath).toBe(configuredPath);
			expect(launch.executablePath).toBeUndefined();
		},
	);

	it("keeps native executables on the direct executable path", () => {
		const { host } = createHost();
		const launch = (host as unknown as BackendHostInternals).resolveBackend("backend.exe");
		expect(launch.executablePath).toBe("backend.exe");
		expect(launch.cliPath).toBeUndefined();
	});

	it("throttles streaming message snapshots and exposes reasoning separately", () => {
		vi.useFakeTimers();
		const { host, onChanged } = createHost();
		const internals = host as unknown as BackendHostInternals;
		internals.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		internals.handleAgentEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "check first" },
		});
		expect(onChanged).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(host.getSnapshot().messages.at(-1)).toEqual(
			expect.objectContaining({ thinking: "check first", streaming: true }),
		);
		vi.useRealTimers();
	});

	it("can retry ensureStarted after the initial refresh fails", async () => {
		rpcState.refreshFailures = 1;
		const { host } = createHost();

		await expect(host.ensureStarted()).rejects.toThrow("initial refresh failed");
		expect(rpcState.clients).toHaveLength(1);
		expect(rpcState.clients[0]?.stopped).toBe(true);

		await expect(host.ensureStarted()).resolves.toBeUndefined();
		expect(rpcState.clients).toHaveLength(2);
		expect(rpcState.clients[1]?.stopped).toBe(false);
		await host.stop();
	});

	it("executes supported slash commands locally instead of sending them to the model", async () => {
		const { host } = createHost();
		await host.prompt("\\model openrouter/anthropic/claude-sonnet");
		expect(rpcState.models).toEqual([["openrouter", "anthropic/claude-sonnet"]]);
		expect(rpcState.prompts).toEqual([]);
		await host.stop();
	});

	it("rejects unknown slash commands instead of sending them to the model", async () => {
		const { host } = createHost();
		await expect(host.prompt("/not-a-command")).rejects.toThrow("未知命令 /not-a-command");
		expect(rpcState.prompts).toEqual([]);
		await host.stop();
	});

	it("rejects a second prompt without changing the running host into an error", async () => {
		const { host } = createHost();
		const internals = host as unknown as BackendHostInternals;
		internals.handleAgentEvent({ type: "agent_start" });

		await expect(host.prompt("second prompt")).rejects.toThrow("AutoPi 正在执行");
		expect(host.getSnapshot().connection).toBe("running");
		expect(rpcState.prompts).toEqual([]);
		await host.stop();
	});

	it("opens a native picker and resumes the selected session locally", async () => {
		const { host } = createHost();
		await host.prompt("/resume");
		expect(vscode.window.showQuickPick).toHaveBeenCalled();
		expect(rpcState.resumedSessions).toEqual(["D:\\sessions\\previous.jsonl"]);
		expect(rpcState.prompts).toEqual([]);
		await host.stop();
	});
});
