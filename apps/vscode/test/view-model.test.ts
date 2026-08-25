import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcAutomation } from "../../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { extractArtifacts, messageText, messageThinking, toUiAutomations, toUiMessages } from "../src/view-model.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VS Code view model", () => {
	it("separates thinking from answer text without rendering tool payloads", async () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "check first" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "secret.txt" } },
				{ type: "text", text: "finished" },
			],
		} as AgentMessage;
		expect(messageText(message)).toBe("finished");
		expect(messageThinking(message)).toBe("check first");
		expect(await toUiMessages([message], process.cwd())).toEqual([
			expect.objectContaining({ text: "finished", thinking: "check first" }),
		]);
	});

	it("only exposes existing artifacts inside the workspace", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "autopi-vscode-"));
		temporaryDirectories.push(workspace);
		await writeFile(path.join(workspace, "eval.md"), "report");
		const artifacts = await extractArtifacts("报告在 `eval.md`，不要打开 `../outside.md`。", workspace);
		expect(artifacts).toEqual([{ label: "eval.md", path: path.join(workspace, "eval.md") }]);
	});

	it("recognizes common source files and Unicode paths", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "autopi-vscode-"));
		temporaryDirectories.push(workspace);
		await writeFile(path.join(workspace, "训练脚本.py"), "print('ok')");
		await writeFile(path.join(workspace, "组件.tsx"), "export default null");
		await writeFile(path.join(workspace, "服务.go"), "package main");

		const artifacts = await extractArtifacts("生成了 训练脚本.py、组件.tsx 和 服务.go。", workspace);
		expect(artifacts.map((artifact) => artifact.label).sort()).toEqual(["服务.go", "组件.tsx", "训练脚本.py"].sort());
	});

	it("presents task logs and cancellation state", () => {
		const automation: RpcAutomation = {
			kind: "background_task",
			id: "task-1",
			sessionId: "session-1",
			status: "running",
			task: {
				id: "task-1",
				sessionId: "session-1",
				command: "python train.py",
				cwd: "D:\\project",
				pid: 42,
				status: "running",
				logPath: "D:\\logs\\task-1.log",
				createdAt: "2026-08-23T00:00:00.000Z",
				updatedAt: "2026-08-23T00:00:00.000Z",
			},
		};
		expect(toUiAutomations([automation])).toEqual([
			expect.objectContaining({ id: "task-1", canCancel: true, logPath: "D:\\logs\\task-1.log" }),
		]);
	});

	it("presents custom monitor state, journal cause, and structured errors", () => {
		const automation: RpcAutomation = {
			kind: "wake",
			id: "wake-1",
			sessionId: "session-1",
			status: "ready",
			wake: {
				schemaVersion: 2,
				id: "wake-1",
				requestKey: "request-1",
				session: { id: "session-1", file: "/sessions/session-1.jsonl", cwd: "/workspace" },
				reason: "Watch the training result",
				objective: "Resume when the custom monitor emits",
				checkFirst: ["Verify the artifact"],
				trigger: {
					type: "monitor",
					adapter: "custom_monitor",
					source: { monitorId: "monitor-1" },
					delivery: { mode: "poll", intervalMs: 1_000 },
					timeout: { at: "2026-08-24T01:00:00.000Z", action: "wake" },
					intent: { kind: "custom", event: "wake_requested" },
				},
				triggerRuntime: {
					checkCount: 3,
					failureCount: 1,
					baselineObserved: true,
					consecutiveMatches: 0,
					cause: "monitor_error",
					monitorError: {
						phase: "monitor",
						code: "CUSTOM_MONITOR_TIMEOUT",
						message: "Monitor exceeded its CPU budget",
						retriable: false,
						at: "2026-08-24T00:59:00.000Z",
					},
				},
				status: "ready",
				runAttempt: 0,
				maxRunAttempts: 3,
				createdAt: "2026-08-24T00:58:00.000Z",
				updatedAt: "2026-08-24T00:59:00.000Z",
			},
		};
		expect(toUiAutomations([automation])[0]?.detail).toContain(
			"monitor custom_monitor · checks 3 · cause monitor_error · CUSTOM_MONITOR_TIMEOUT",
		);
	});
});
