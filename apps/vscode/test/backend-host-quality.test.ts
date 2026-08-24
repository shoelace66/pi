import path from "node:path";
import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockRpcClient = {
	stopped: boolean;
};

const rpcState = vi.hoisted(() => ({
	clients: [] as MockRpcClient[],
	refreshFailures: 0,
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

	it("does not publish a full snapshot for message deltas that change no host state", () => {
		const { host, onChanged } = createHost();
		const internals = host as unknown as BackendHostInternals;
		internals.handleAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
		expect(onChanged).not.toHaveBeenCalled();

		internals.handleAgentEvent({ type: "agent_start" });
		expect(onChanged).toHaveBeenCalledTimes(1);
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
});
