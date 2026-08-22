import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStateAdapter } from "../src/core/outer-loop/adapters/file-state.ts";
import { createProcessStateAdapter } from "../src/core/outer-loop/adapters/process-state.ts";
import { evaluateMonitorCondition } from "../src/core/outer-loop/condition-evaluator.ts";
import { InMemoryWakeStore } from "../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../src/core/outer-loop/monitor-registry.ts";
import { OuterLoopRuntime } from "../src/core/outer-loop/runtime.ts";
import { createOuterLoopTool } from "../src/core/outer-loop/tool.ts";
import type { WakeJob } from "../src/core/outer-loop/types.ts";
import { normalizeCreateWakeInput, WakePolicyError } from "../src/core/outer-loop/wake-policy.ts";
import { WakeScheduler } from "../src/core/outer-loop/wake-scheduler.ts";
import { WakeRuntime } from "../src/core/wake/runtime.ts";

const tempDirs: string[] = [];

function sessionInput(
	trigger: WakeJob["trigger"] = { type: "time", dueAt: new Date(Date.now() + 300_000).toISOString() },
) {
	return {
		requestKey: `session-1:${Math.random()}`,
		session: { id: "session-1", file: "C:\\sessions\\session-1.jsonl", cwd: "C:\\workspace" },
		trigger,
		reason: "等待外部状态",
		objective: "检查状态并继续任务",
		checkFirst: ["重新读取当前状态"],
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("outer-loop core", () => {
	it("keeps lifecycle semantics in process memory and deduplicates request keys", async () => {
		const store = new InMemoryWakeStore();
		const first = await store.createOnce({ ...sessionInput(), requestKey: "same-request" });
		const duplicate = await store.createOnce({ ...sessionInput(), requestKey: "same-request" });
		expect(duplicate.deduplicated).toBe(true);
		await store.markReady(first.job.id, { cause: "time_due" });
		const claimed = await store.claimReady(first.job.id, "memory-worker", 60_000);
		expect(claimed?.job.status).toBe("running");
		expect(await store.completeRun(first.job.id, claimed!.leaseToken)).toBe(true);
		expect((await store.listBySession("session-1", ["completed"])).map((job) => job.id)).toEqual([first.job.id]);
	});

	it("does not publish a status change for an unchanged monitor poll", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-outer-loop-render-test-"));
		tempDirs.push(dir);
		const runtime = new OuterLoopRuntime({ cwd: dir, wakeRuntime: new WakeRuntime({ agentDir: dir }) });
		let changedEvents = 0;
		runtime.subscribe((event) => {
			if (event.type === "changed") changedEvents++;
		});
		await runtime.store.createOnce({
			...sessionInput({
				type: "monitor",
				adapter: "file_state",
				source: { path: join(dir, "still-missing.txt") },
				condition: { field: "exists", operator: "eq", expected: true, activation: "level", consecutiveMatches: 1 },
				delivery: { mode: "poll", intervalMs: 30_000 },
				timeout: { at: new Date(Date.now() + 300_000).toISOString(), action: "wake" },
			}),
			session: { id: "session-1", file: join(dir, "session.jsonl"), cwd: dir },
		});
		const firstPoll = new Date(Date.now() + 1_000);
		await runtime.scheduler.tick(firstPoll);
		await runtime.scheduler.tick(new Date(firstPoll.getTime() + 30_000));
		expect(changedEvents).toBe(1);
		await runtime.stop();
	});

	it("exposes only intent actions and rejects non-persisted sessions or project escapes", async () => {
		const store = new InMemoryWakeStore();
		const tool = createOuterLoopTool({ store, monitorRegistry: new MonitorRegistry(), allowedRoot: "C:\\workspace" });
		const schema = JSON.stringify(tool.parameters);
		expect(schema).toContain('"wait_time"');
		expect(schema).toContain('"wait_file"');
		expect(schema).toContain('"wait_process"');
		expect(schema).not.toContain('"operator"');
		expect(schema).not.toContain('"activation"');
		expect(schema).not.toContain('"note"');
		const executeContext = (sessionFile: string | undefined, cwd = "C:\\workspace") => ({
			cwd,
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session-1" },
		});
		await expect(
			tool.execute!(
				"call-1",
				{ action: "wait_time", reason: "等待", objective: "继续", after: 60_000 },
				undefined,
				undefined,
				executeContext(undefined) as never,
			),
		).rejects.toMatchObject({ code: "WAKE_SESSION_NOT_PERSISTED" });
		await expect(
			tool.execute!(
				"call-2",
				{
					action: "wait_file",
					reason: "等待",
					objective: "继续",
					path: "..\\outside.txt",
					event: "exists",
					timeout: { kind: "after", value: "00:05:00", onTimeout: "expire" },
				},
				undefined,
				undefined,
				executeContext("C:\\workspace\\session.jsonl") as never,
			),
		).rejects.toMatchObject({ code: "OUTER_LOOP_PATH_OUTSIDE_PROJECT" });
	});

	it("returns normalized dueAt and objective in wait_time output", async () => {
		const store = new InMemoryWakeStore();
		const tool = createOuterLoopTool({ store, monitorRegistry: new MonitorRegistry(), allowedRoot: "C:\\workspace" });
		const result = await tool.execute!(
			"call-time",
			{ action: "wait_time", reason: "等待", objective: "继续构建", after: "00:01:00" },
			undefined,
			undefined,
			{
				cwd: "C:\\workspace",
				sessionManager: { getSessionFile: () => "C:\\workspace\\session.jsonl", getSessionId: () => "session-1" },
			} as never,
		);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/dueAt=/);
		expect((result.details as { job: WakeJob }).job.objective).toBe("继续构建");
	});

	it("prepares duration units as milliseconds and rejects invalid ranges", () => {
		const tool = createOuterLoopTool({
			store: new InMemoryWakeStore(),
			monitorRegistry: new MonitorRegistry(),
			allowedRoot: "C:\\workspace",
		});
		const prepare = tool.prepareArguments!;
		expect(() => prepare({ action: "wait_time", after: 60 })).toThrow(/60000ms.*milliseconds/);
		expect(() => prepare({ action: "wait_time", after: "1:00:00" })).toThrow(/HH:MM:SS/);
		expect(prepare({ action: "wait_time", after: "00:01:00" })).toMatchObject({ after: 60_000 });
	});

	it("keeps monitor errors armed instead of treating query failure as a match", async () => {
		const store = new InMemoryWakeStore();
		const monitorRegistry = new MonitorRegistry();
		monitorRegistry.register(
			createProcessStateAdapter({
				platform: "win32",
				query: async () => {
					throw Object.assign(new Error("access denied"), { code: "PROCESS_STATE_QUERY_FAILED" });
				},
			}),
		);
		const created = await store.createOnce({
			...sessionInput({
				type: "monitor",
				adapter: "process_state",
				source: { pid: 99 },
				condition: {
					field: "running",
					operator: "eq",
					expected: false,
					activation: "level",
					consecutiveMatches: 1,
				},
				delivery: { mode: "poll", intervalMs: 30_000 },
				timeout: { at: new Date(Date.now() + 300_000).toISOString(), action: "wake" },
			}),
		});
		const scheduler = new WakeScheduler({ store, monitorRegistry, runner: { run: async () => true } as never });
		const result = await scheduler.sampleNow(created.job);
		expect(result?.status).toBe("armed");
		expect(result?.triggerRuntime?.cause).toBe("monitor_error");
		expect(result?.triggerRuntime?.monitorError?.code).toBe("PROCESS_STATE_QUERY_FAILED");
	});

	it("preserves monitor transition baselines and safe adapter observations", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-file-state-test-"));
		tempDirs.push(dir);
		const file = join(dir, "state.txt");
		await writeFile(file, "ready", "utf8");
		const adapter = createFileStateAdapter({ allowedRoots: [dir], maxHashBytes: 1024 });
		const observation = await adapter.observe({ path: file, includeHash: true });
		expect(observation.fields.exists).toBe(true);
		expect(observation.fields.sha256).toBeTypeOf("string");
		const job = {
			...sessionInput({
				type: "monitor",
				adapter: "test",
				source: {},
				condition: {
					field: "status",
					operator: "eq",
					expected: "done",
					activation: "transition",
					consecutiveMatches: 1,
				},
				delivery: { mode: "poll", intervalMs: 30_000 },
				timeout: { at: new Date(Date.now() + 300_000).toISOString(), action: "wake" },
			}),
			status: "armed",
			triggerRuntime: { checkCount: 0, failureCount: 0, baselineObserved: false, consecutiveMatches: 0 },
		} as WakeJob;
		const done = { observedAt: new Date().toISOString(), fields: { status: "done" }, summary: "done" };
		expect(evaluateMonitorCondition(job, done).matched).toBe(true);
		expect(
			evaluateMonitorCondition({ ...job, triggerRuntime: { ...job.triggerRuntime!, baselineObserved: true } }, done)
				.matched,
		).toBe(true);
	});

	it("rejects timezone-less times and invalid monitor windows", () => {
		expect(() =>
			normalizeCreateWakeInput({ ...sessionInput(), trigger: { type: "time", dueAt: "2030-01-01T00:00:00" } }),
		).toThrow(WakePolicyError);
		expect(() =>
			normalizeCreateWakeInput({
				...sessionInput({
					type: "monitor",
					adapter: "test",
					source: {},
					condition: { field: "status", operator: "exists", activation: "level", consecutiveMatches: 1 },
					delivery: { mode: "poll", intervalMs: 1_000 },
					timeout: { at: new Date(Date.now() + 300_000).toISOString(), action: "wake" },
				}),
			}),
		).toThrow(WakePolicyError);
	});
});
