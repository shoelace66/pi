import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStateAdapter } from "../../../src/core/outer-loop/adapters/file-state.ts";
import { evaluateMonitorCondition } from "../../../src/core/outer-loop/condition-evaluator.ts";
import { InMemoryWakeStore } from "../../../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../../../src/core/outer-loop/monitor-registry.ts";
import type { MonitorObservation, WakeJob } from "../../../src/core/outer-loop/types.ts";
import { WakeScheduler } from "../../../src/core/outer-loop/wake-scheduler.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function monitorJob(condition: NonNullable<Extract<WakeJob["trigger"], { type: "monitor" }>["condition"]>): WakeJob {
	return {
		requestKey: "trap",
		session: { id: "session-1", file: "C:\\sessions\\session-1.jsonl", cwd: "C:\\workspace" },
		trigger: {
			type: "monitor",
			adapter: "file_state",
			source: { path: "C:\\workspace\\missing.txt" },
			condition,
			delivery: { mode: "poll", intervalMs: 30_000 },
			timeout: { at: new Date(Date.now() + 300_000).toISOString(), action: "wake" },
		},
		reason: "trap regression",
		objective: "pin exists operator behavior",
		checkFirst: [],
		schemaVersion: 2,
		id: "wake_trap",
		status: "armed",
		runAttempt: 0,
		maxRunAttempts: 3,
		leaseGeneration: 0,
		triggerRuntime: { checkCount: 0, failureCount: 0, baselineObserved: false, consecutiveMatches: 0 },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("wakeup exists-operator semantics", () => {
	it("guards operator=exists against treating an absent file as present", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-trap-"));
		tempDirs.push(dir);
		const adapter = createFileStateAdapter({ allowedRoots: [dir] });
		const observation = await adapter.observe({ path: join(dir, "missing.txt") });

		// FileStateAdapter always emits `exists` (true/false). The guarded
		// exists operator treats the semantic boolean as the condition value.
		expect(observation.fields.exists).toBe(false);
		const evaluation = evaluateMonitorCondition(
			monitorJob({ field: "exists", operator: "exists", activation: "level", consecutiveMatches: 1 }),
			observation,
		);
		expect(evaluation.matched).toBe(false);
	});

	it("the correct exists monitor (eq true) stays armed while absent and matches when it appears", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-trap-"));
		tempDirs.push(dir);
		const file = join(dir, "flag.txt");
		const store = new InMemoryWakeStore();
		const monitorRegistry = new MonitorRegistry();
		monitorRegistry.register(createFileStateAdapter({ allowedRoots: [dir] }));
		const scheduler = new WakeScheduler({ store, monitorRegistry, runner: { run: async () => true } as never });

		const now = Date.now();
		await store.createOnce({
			requestKey: "exists-eq",
			session: { id: "session-1", file: "C:\\sessions\\session-1.jsonl", cwd: "C:\\workspace" },
			trigger: {
				type: "monitor",
				adapter: "file_state",
				source: { path: file, includeHash: false },
				condition: { field: "exists", operator: "eq", expected: true, activation: "level", consecutiveMatches: 1 },
				delivery: { mode: "poll", intervalMs: 30_000 },
				timeout: { at: new Date(now + 300_000).toISOString(), action: "wake" },
			},
			reason: "exists eq true",
			objective: "wait for file",
			checkFirst: [],
		});

		// First observation: file absent -> no match, must stay armed.
		await scheduler.tick(new Date(now));
		expect((await store.listBySession("session-1"))[0]!.status).toBe("armed");
		expect((await store.listBySession("session-1"))[0]!.triggerRuntime?.cause).toBeUndefined();

		// File appears -> next observation matches.
		await writeFile(file, "now it exists", "utf8");
		await scheduler.tick(new Date(now + 30_000));
		const job = (await store.listBySession("session-1"))[0]!;
		expect(job.status).toBe("ready");
		expect(job.triggerRuntime?.cause).toBe("monitor_match");
		expect((job.triggerRuntime?.evidence as MonitorObservation | undefined)?.fields.exists).toBe(true);
	});
});
