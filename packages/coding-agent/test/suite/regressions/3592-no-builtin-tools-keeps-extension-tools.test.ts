import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { WakeRuntime } from "../../../src/core/wake/runtime.ts";

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "dynamic_tool", "edit", "find", "grep", "ls", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["dynamic_tool"]);
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("still disables all tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("keeps Wake available when tools and extensions are disabled", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
		});
		await resourceLoader.reload();
		const wakeRuntime = new WakeRuntime({ agentDir });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			wakeRuntime,
			noTools: "all",
		});
		try {
			expect(session.getAllTools()).toEqual([]);
			const wake = session.extensionRunner.createContext().wake;
			expect(wake).toBeDefined();
			const registration = await wake!.register({
				requestKey: "no-tools",
				producer: { id: "test" },
				reason: "verify native Wake",
				objective: "remain available",
			});
			expect(registration.signal.aborted).toBe(false);
		} finally {
			session.dispose();
			await wakeRuntime.stop();
		}
	});
});
