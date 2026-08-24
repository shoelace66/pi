import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-task/manager.ts";
import { createProcessStateAdapter } from "../src/core/outer-loop/adapters/process-state.ts";
import { CustomMonitorManager } from "../src/core/outer-loop/custom-monitor.ts";
import { InMemoryWakeStore } from "../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../src/core/outer-loop/monitor-registry.ts";
import { createOuterLoopTool } from "../src/core/outer-loop/tool.ts";
import type { WakeJob } from "../src/core/outer-loop/types.ts";
import { WakeScheduler } from "../src/core/outer-loop/wake-scheduler.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(script: string, allowedOrigins: string[] = []) {
	const root = await mkdtemp(join(tmpdir(), "pi-custom-monitor-test-"));
	tempDirs.push(root);
	const scriptPath = join(root, "monitor.js");
	await writeFile(scriptPath, script, "utf8");
	const taskManager = new BackgroundTaskManager({ allowedRoots: [root] });
	const manager = new CustomMonitorManager({
		taskManager,
		processStateAdapter: createProcessStateAdapter(),
		policyForRoot: () => ({ enabled: true, projectTrusted: true, allowedOrigins }),
	});
	return { root, manager, taskManager };
}

async function register(manager: CustomMonitorManager, root: string, requestedOrigins?: string[]) {
	return manager.register({
		root,
		sessionId: "session-1",
		scriptPath: "monitor.js",
		requestedOrigins,
	});
}

describe("custom monitor isolation", () => {
	it("registers wait_custom with mandatory rechecks and self-report intent", async () => {
		const { root, manager, taskManager } = await setup(
			'function monitor() { return { type: "continue", message: "still training" }; }',
		);
		const store = new InMemoryWakeStore();
		const registry = new MonitorRegistry();
		registry.register(manager);
		const scheduler = new WakeScheduler({
			store,
			monitorRegistry: registry,
			runner: { run: async () => false } as never,
		});
		const tool = createOuterLoopTool({
			store,
			monitorRegistry: registry,
			taskManager,
			customMonitorManager: manager,
			allowedRoot: root,
			sampleMonitor: (job) => scheduler.sampleNow(job),
		});
		const executeContext = {
			cwd: root,
			sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session-1" },
		} as never;
		await expect(
			tool.execute!(
				"missing-recheck",
				{
					action: "wait_custom",
					reason: "training is running",
					objective: "test the model",
					scriptPath: "monitor.js",
					timeout: { kind: "after", value: "00:01:00", onTimeout: "wake" },
				},
				undefined,
				undefined,
				executeContext,
			),
		).rejects.toMatchObject({ code: "OUTER_LOOP_INVALID_INPUT" });
		const result = await tool.execute!(
			"custom-wait",
			{
				action: "wait_custom",
				reason: "training is running",
				objective: "test the model",
				checkFirst: ["read the task exit code", "hash the model artifact"],
				scriptPath: "monitor.js",
				timeout: { kind: "after", value: "00:01:00", onTimeout: "wake" },
			},
			undefined,
			undefined,
			executeContext,
		);
		const job = (result.details as { job: WakeJob }).job;
		expect(job).toMatchObject({
			status: "armed",
			checkFirst: ["read the task exit code", "hash the model artifact"],
			trigger: {
				type: "monitor",
				adapter: "custom_monitor",
				intent: { kind: "custom", event: "wake_requested" },
				timeout: { action: "wake" },
				source: { scriptSha256: expect.any(String) },
			},
		});
	});

	it("enforces the global origin ceiling before registration", async () => {
		const { root, manager } = await setup('function monitor() { return { type: "continue" }; }', [
			"https://allowed.example",
		]);
		await expect(register(manager, root, ["https://denied.example"])).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_ORIGIN_NOT_ALLOWED",
		});
	});

	it("rejects script paths and host file requests outside the project", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-custom-monitor-path-test-"));
		tempDirs.push(base);
		const root = join(base, "project");
		await mkdir(root);
		await writeFile(join(base, "outside.js"), 'function monitor() { return { type: "continue" }; }', "utf8");
		const taskManager = new BackgroundTaskManager({ allowedRoots: [root] });
		const manager = new CustomMonitorManager({
			taskManager,
			processStateAdapter: createProcessStateAdapter(),
			policyForRoot: () => ({ enabled: true, projectTrusted: true, allowedOrigins: [] }),
		});
		await expect(
			manager.register({ root, sessionId: "session-1", scriptPath: "../outside.js" }),
		).rejects.toMatchObject({ code: "CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT" });

		await writeFile(
			join(root, "monitor.js"),
			'function monitor() { return { type: "request", request: { kind: "file_read", path: "../secret" } }; }',
			"utf8",
		);
		const registered = await register(manager, root);
		await expect(manager.observe({ monitorId: registered.monitorId })).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT",
			wakeImmediately: true,
		});
	});

	it("interrupts infinite loops and enforces the QuickJS memory limit", async () => {
		const loop = await setup("function monitor() { while (true) {} }");
		const loopRegistration = await register(loop.manager, loop.root);
		await expect(loop.manager.observe({ monitorId: loopRegistration.monitorId })).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_CPU_LIMIT",
			wakeImmediately: true,
		});

		const memory = await setup("function monitor() { new ArrayBuffer(64 * 1024 * 1024); }");
		const memoryRegistration = await register(memory.manager, memory.root);
		await expect(memory.manager.observe({ monitorId: memoryRegistration.monitorId })).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_MEMORY_LIMIT",
			wakeImmediately: true,
		});
	});

	it("validates wake events and rejects duplicate self-reports", async () => {
		const invalid = await setup('function monitor() { return { type: "wake", eventId: "", message: "not valid" }; }');
		const invalidRegistration = await register(invalid.manager, invalid.root);
		await expect(invalid.manager.observe({ monitorId: invalidRegistration.monitorId })).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_INVALID_WAKE",
			wakeImmediately: true,
		});

		const duplicate = await setup(
			'function monitor() { return { type: "wake", eventId: "done-1", message: "please verify", data: { selfReported: true } }; }',
		);
		const duplicateRegistration = await register(duplicate.manager, duplicate.root);
		const first = await duplicate.manager.observe({ monitorId: duplicateRegistration.monitorId });
		expect(first.fields).toMatchObject({
			wakeRequested: true,
			wakeEvent: { eventId: "done-1", message: "please verify", data: { selfReported: true } },
		});
		await expect(duplicate.manager.observe({ monitorId: duplicateRegistration.monitorId })).rejects.toMatchObject({
			code: "CUSTOM_MONITOR_DUPLICATE_EVENT",
			wakeImmediately: true,
		});
	});

	it("feeds bounded host results back to the script and marks monitor failures ready", async () => {
		const successful = await setup(`
			function monitor(frame) {
				if (frame.lastResult === null) {
					return { type: "request", request: { kind: "file_read", path: "artifact.txt", maxBytes: 64 } };
				}
				return { type: "wake", eventId: "artifact-ready", message: frame.lastResult.text };
			}
		`);
		await writeFile(join(successful.root, "artifact.txt"), "verified artifact", "utf8");
		const successfulRegistration = await register(successful.manager, successful.root);
		const observation = await successful.manager.observe({ monitorId: successfulRegistration.monitorId });
		expect(observation.fields).toMatchObject({
			wakeRequested: true,
			wakeEvent: { eventId: "artifact-ready", message: "verified artifact" },
		});

		const failing = await setup("function monitor() { while (true) {} }");
		const failingRegistration = await register(failing.manager, failing.root);
		const store = new InMemoryWakeStore();
		const registry = new MonitorRegistry();
		registry.register(failing.manager);
		const created = await store.createOnce({
			requestKey: "custom-failure",
			session: { id: "session-1", file: join(failing.root, "session.jsonl"), cwd: failing.root },
			reason: "wait for custom state",
			objective: "verify before continuing",
			checkFirst: ["inspect the real artifact"],
			trigger: {
				type: "monitor",
				adapter: "custom_monitor",
				source: { monitorId: failingRegistration.monitorId },
				condition: {
					field: "wakeRequested",
					operator: "eq",
					expected: true,
					activation: "level",
					consecutiveMatches: 1,
				},
				intent: { kind: "custom", event: "wake_requested" },
				delivery: { mode: "poll", intervalMs: 30_000 },
				timeout: { at: new Date(Date.now() + 60_000).toISOString(), action: "wake" },
			},
		});
		const scheduler = new WakeScheduler({
			store,
			monitorRegistry: registry,
			runner: { run: async () => false } as never,
		});
		const ready = await scheduler.sampleNow(created.job);
		expect(ready).toMatchObject({
			status: "ready",
			triggerRuntime: {
				cause: "monitor_error",
				monitorError: { code: "CUSTOM_MONITOR_CPU_LIMIT", retriable: false },
			},
		});
	});
});
