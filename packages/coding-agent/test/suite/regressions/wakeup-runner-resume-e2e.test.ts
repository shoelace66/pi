import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWakeService } from "../../../src/core/wakeup/agent-wake.ts";
import { InMemoryWakeStore } from "../../../src/core/wakeup/in-memory-wake-store.ts";
import { MonitorRegistry } from "../../../src/core/wakeup/monitor-registry.ts";
import { WakeRunner } from "../../../src/core/wakeup/wake-runner.ts";
import { WakeScheduler } from "../../../src/core/wakeup/wake-scheduler.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("production outer-loop wake path", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs scheduler → AgentWakeService → native preflight → settled with extension compatibility", async () => {
		const preflightPrompts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						preflightPrompts.push(event.prompt);
						return { systemPrompt: `${event.systemPrompt}\nfixture extension marker` };
					});
					pi.registerTool({
						name: "fixture_tool",
						label: "Fixture tool",
						description: "Native extension fixture tool",
						promptSnippet: "Use the fixture tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const sessionFile = join(harness.tempDir, "session.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "e2e-wake-session",
				timestamp: new Date().toISOString(),
				cwd: harness.tempDir,
			})}\n`,
			"utf8",
		);

		const store = new InMemoryWakeStore();
		const wakeService = new AgentWakeService({
			resolver: { resolve: async () => ({ session: harness.session }) },
		});
		const runner = new WakeRunner({ store, workerId: "e2e-worker", wakeService });
		const scheduler = new WakeScheduler({ store, monitorRegistry: new MonitorRegistry(), runner });
		const now = Date.now();
		const created = await store.createOnce({
			requestKey: "e2e-production-wake",
			session: { id: "e2e-wake-session", file: sessionFile, cwd: harness.tempDir },
			trigger: { type: "time", dueAt: new Date(now + 60_000).toISOString() },
			reason: "e2e production path",
			objective: "verify unified wake and native extension preflight",
			checkFirst: ["re-check the build result"],
		});

		const providerSystemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("wake acknowledged");
			},
		]);
		await scheduler.tick(new Date(now + 60_001));

		const job = (await store.listBySession("e2e-wake-session"))[0]!;
		expect(job.status).toBe("completed");
		expect(job.triggerRuntime?.cause).toBe("time_due");
		expect(preflightPrompts).toHaveLength(1);
		expect(preflightPrompts[0]).toContain("<outer_loop_wake");
		expect(providerSystemPrompts[0]).toContain("fixture extension marker");
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("fixture_tool");

		const wakeEvent = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "outer_loop_wake",
		);
		expect(wakeEvent).toBeDefined();
		expect((wakeEvent!.details as { requestId: string }).requestId).toBe(`${created.job.id}:1`);
		expect(harness.eventsOfType("agent_settled").length).toBeGreaterThanOrEqual(1);
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles.indexOf("assistant")).toBeGreaterThan(roles.indexOf("custom"));
	});

	it("deduplicates the same requestId without injecting a second wake message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new AgentWakeService({ resolver: { resolve: async () => ({ session: harness.session }) } });
		harness.setResponses([fauxAssistantMessage("one wake")]);
		const request = {
			requestId: "duplicate-request",
			target: { kind: "pi_session" as const, session: { id: "s", file: "session.jsonl", cwd: harness.tempDir } },
			source: {
				kind: "agent" as const,
				claimedFrom: { agentId: "agent-a" },
				verification: "self_reported" as const,
				message: "coordinate",
			},
		};
		const [first, second] = await Promise.all([service.wake(request), service.wake(request)]);
		expect(first).toEqual(second);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "outer_loop_wake",
			),
		).toHaveLength(1);
	});

	it("waits for a busy target to settle instead of steering it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let releaseUserTurn!: () => void;
		let userTurnStarted!: () => void;
		const userStarted = new Promise<void>((resolve) => {
			userTurnStarted = resolve;
		});
		const userRelease = new Promise<void>((resolve) => {
			releaseUserTurn = resolve;
		});
		harness.setResponses([
			async () => {
				userTurnStarted();
				await userRelease;
				return fauxAssistantMessage("user turn");
			},
			fauxAssistantMessage("wake turn"),
		]);
		const userTurn = harness.session.prompt("long user turn");
		await userStarted;
		const service = new AgentWakeService({ resolver: { resolve: async () => ({ session: harness.session }) } });
		const wake = service.wake({
			requestId: "busy-target",
			target: { kind: "pi_session", session: { id: "s", file: "session.jsonl", cwd: harness.tempDir } },
			source: { kind: "timer", wakeId: "wake_busy", scheduledAt: new Date().toISOString() },
			job: { id: "wake_busy", reason: "busy", objective: "continue", checkFirst: [] },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		releaseUserTurn();
		await userTurn;
		await expect(wake).resolves.toMatchObject({ status: "completed" });
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "outer_loop_wake",
			),
		).toHaveLength(1);
	});
});
