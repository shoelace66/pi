import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWakeStore } from "../../../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../../../src/core/outer-loop/monitor-registry.ts";
import { WakeRunner } from "../../../src/core/outer-loop/wake-runner.ts";
import { WakeScheduler } from "../../../src/core/outer-loop/wake-scheduler.ts";
import { WakeClient } from "../../../src/core/wake/client.ts";
import { WakeRuntime } from "../../../src/core/wake/runtime.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("production outer-loop wake path", () => {
	const harnesses: Harness[] = [];
	const runtimes: WakeRuntime[] = [];

	afterEach(async () => {
		await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs scheduler → WakeRuntime → native preflight → settled with extension compatibility", async () => {
		const preflightPrompts: string[] = [];
		const harness = await createHarness({
			persistedSession: true,
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
		harness.setResponses([fauxAssistantMessage("session initialized")]);
		await harness.session.prompt("initialize persisted session");
		await harness.session.bindExtensions({});

		const store = new InMemoryWakeStore();
		const wakeRuntime = new WakeRuntime({ agentDir: harness.tempDir });
		runtimes.push(wakeRuntime);
		const binding = await wakeRuntime.bindSession(harness.session);
		expect(binding.owned).toBe(true);
		const context = wakeRuntime.contextForSession(harness.session)!;
		const runner = new WakeRunner({
			store,
			workerId: "e2e-worker",
			resolveRegistration: (job) =>
				context.register({
					requestKey: `${job.id}:${job.runAttempt}`,
					producer: { id: "outer_loop" },
					reason: job.reason,
					objective: job.objective,
					checkFirst: job.checkFirst,
				}),
		});
		const scheduler = new WakeScheduler({ store, monitorRegistry: new MonitorRegistry(), runner });
		const now = Date.now();
		const created = await store.createOnce({
			requestKey: "e2e-production-wake",
			session: {
				id: harness.sessionManager.getSessionId(),
				file: harness.sessionManager.getSessionFile()!,
				cwd: harness.tempDir,
			},
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

		const job = (await store.listBySession(harness.sessionManager.getSessionId()))[0]!;
		expect(job.status).toBe("completed");
		expect(job.triggerRuntime?.cause).toBe("time_due");
		expect(preflightPrompts.at(-1)).toContain("[WAKE_EVENT v1]");
		expect(providerSystemPrompts[0]).toContain("fixture extension marker");
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("fixture_tool");

		const wakeEvent = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "wake_event",
		);
		expect(wakeEvent).toBeDefined();
		expect((wakeEvent!.details as { event: { eventId: string } }).event.eventId).toBe(`${created.job.id}:1`);
		expect(harness.eventsOfType("agent_settled").length).toBeGreaterThanOrEqual(1);
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles.lastIndexOf("assistant")).toBeGreaterThan(roles.indexOf("custom"));
	});

	it("deduplicates the same requestId without injecting a second wake message", async () => {
		const harness = await createHarness({ persistedSession: true });
		harnesses.push(harness);
		const runtime = new WakeRuntime({ agentDir: harness.tempDir });
		runtimes.push(runtime);
		await runtime.bindSession(harness.session);
		const registration = await runtime.contextForSession(harness.session)!.register({
			requestKey: "duplicate-request",
			producer: { id: "test" },
			reason: "dedupe",
			objective: "run once",
		});
		const address = await registration.createCapability();
		const client = new WakeClient();
		harness.setResponses([fauxAssistantMessage("one wake")]);
		const event = { eventId: "same-event", message: "coordinate" };
		const [first, second] = await Promise.all([client.emit(address, event), client.emit(address, event)]);
		expect(new Set([first.status, second.status])).toEqual(new Set(["accepted", "duplicate"]));
		expect(first.requestId).toBe(second.requestId);
		await expect(registration.outcome).resolves.toMatchObject({ status: "completed" });
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "wake_event"),
		).toHaveLength(1);
	});

	it("waits for a busy target to settle instead of steering it", async () => {
		const harness = await createHarness({ persistedSession: true });
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
		const runtime = new WakeRuntime({ agentDir: harness.tempDir });
		runtimes.push(runtime);
		await runtime.bindSession(harness.session);
		const registration = await runtime.contextForSession(harness.session)!.register({
			requestKey: "busy-target",
			producer: { id: "test" },
			reason: "busy",
			objective: "continue",
		});
		const wake = registration.emit({ eventId: "wake-busy", message: "target became ready" });
		await expect(wake).resolves.toMatchObject({ status: "accepted" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		releaseUserTurn();
		await userTurn;
		await expect(registration.outcome).resolves.toMatchObject({ status: "completed" });
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "wake_event"),
		).toHaveLength(1);
	});
});
