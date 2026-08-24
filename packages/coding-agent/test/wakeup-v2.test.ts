import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOuterLoopClockExtension, formatOuterLoopClock } from "../src/core/outer-loop/clock-extension.ts";
import { InMemoryWakeStore } from "../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../src/core/outer-loop/monitor-registry.ts";
import { createOuterLoopTool } from "../src/core/outer-loop/tool.ts";
import type { WakeJob } from "../src/core/outer-loop/types.ts";
import { findUnclosedWakeEvents, InMemoryWakeJournal, JsonlWakeJournal } from "../src/core/wake/journal.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("outer-loop v2 intent contract", () => {
	it("exposes only intent-level actions to the model", () => {
		const tool = createOuterLoopTool({
			store: new InMemoryWakeStore(),
			monitorRegistry: new MonitorRegistry(),
			allowedRoot: "C:\\workspace",
		});
		const schema = JSON.stringify(tool.parameters);
		expect(schema).toContain('"wait_time"');
		expect(schema).toContain('"wait_file"');
		expect(schema).toContain('"wait_process"');
		expect(schema).toContain('"wait_task"');
		expect(schema).not.toContain('"operator"');
		expect(schema).not.toContain('"activation"');
		expect(schema).not.toContain('"note"');
		expect(tool.promptGuidelines?.join("\n")).toContain("milliseconds");
		expect(tool.promptGuidelines?.join("\n")).toContain("checkFirst is advisory");
	});

	it("defaults wait_task to the only supported finished event", () => {
		const tool = createOuterLoopTool({
			store: new InMemoryWakeStore(),
			monitorRegistry: new MonitorRegistry(),
			allowedRoot: "C:\\workspace",
		});
		expect(
			tool.prepareArguments?.({
				action: "wait_task",
				taskId: "task_1",
				reason: "wait",
				objective: "continue",
				checkFirst: [],
				timeout: { kind: "after", value: "00:01:00", onTimeout: "wake" },
			}),
		).toMatchObject({ action: "wait_task", event: "finished" });
	});

	it("lists objective and normalized due information in the text result", async () => {
		const store = new InMemoryWakeStore();
		const tool = createOuterLoopTool({ store, monitorRegistry: new MonitorRegistry(), allowedRoot: "C:\\workspace" });
		await store.createOnce({
			requestKey: "list-output",
			session: { id: "session", file: "C:\\workspace\\session.jsonl", cwd: "C:\\workspace" },
			reason: "等待结果",
			objective: "继续构建",
			checkFirst: [],
			trigger: { type: "time", dueAt: new Date(Date.now() + 120_000).toISOString() },
		});
		const result = await tool.execute!("list-call", { action: "list" }, undefined, undefined, {
			cwd: "C:\\workspace",
			sessionManager: { getSessionId: () => "session", getSessionFile: () => "C:\\workspace\\session.jsonl" },
		} as never);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("objective=继续构建");
		expect(text).toContain("due=");
	});

	it("keeps the native prompt unchanged when no jobs exist", async () => {
		const store = new InMemoryWakeStore();
		const extension = createOuterLoopClockExtension(store, () => "session");
		const handlers: Array<(event: { systemPrompt: string }) => Promise<unknown>> = [];
		const pi = {
			on: (_event: string, handler: (event: { systemPrompt: string }) => Promise<unknown>) => handlers.push(handler),
		};
		(extension as { factory: (value: unknown) => void }).factory(pi);
		expect(await handlers[0]!({ systemPrompt: "native" })).toBeUndefined();
	});

	it("shows at most ten clocks and a remainder hint", () => {
		const jobs = Array.from({ length: 12 }, (_, index) => ({
			id: `wake_${index}`,
			status: "armed",
			reason: `reason ${index}`,
			trigger: { type: "time", dueAt: "2030-01-01T00:00:00.000Z" },
		})) as unknown as WakeJob[];
		const clock = formatOuterLoopClock(jobs, "2026-01-01T00:00:00.000Z");
		expect(clock.match(/clock: wake_/g)).toHaveLength(10);
		expect(clock).toContain("and 2 more");
	});

	it("persists journal envelopes and user cancellation state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-wake-journal-"));
		tempDirs.push(dir);
		const journal = new JsonlWakeJournal({ agentDir: dir });
		const store = new InMemoryWakeStore({ journal });
		const created = await store.createOnce({
			requestKey: "v2-cancel",
			session: { id: "session", file: join(dir, "session.jsonl"), cwd: dir },
			reason: "wait",
			objective: "continue",
			checkFirst: [],
			trigger: { type: "time", dueAt: new Date(Date.now() + 120_000).toISOString() },
		});
		const cancelled = await store.cancelByUser(created.job.id);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.notification).toBe("next_turn");
		expect((await store.listPendingUserNotifications!("session"))[0]?.wakeId).toBe(created.job.id);
		expect((await journal.read()).map((event) => event.kind)).toEqual(["accepted", "cancelled"]);
		const memoryJournal = new InMemoryWakeJournal();
		expect(await memoryJournal.append({ kind: "accepted" })).toBe(1);
	});

	it("identifies unfinished wakes for a non-triggering recovery notice", async () => {
		const journal = new InMemoryWakeJournal();
		await journal.append({
			kind: "accepted",
			resourceId: "wake_open",
			target: { id: "session" },
		});
		await journal.append({ kind: "dispatching", resourceId: "wake_open" });
		await journal.append({ kind: "accepted", resourceId: "wake_done", target: { id: "session" } });
		await journal.append({ kind: "completed", resourceId: "wake_done" });
		expect(findUnclosedWakeEvents(await journal.read(), "session")).toEqual([
			{ resourceId: "wake_open", lastKind: "dispatching", journalPath: undefined },
		]);
		await journal.append({ kind: "recovery_notice_delivered", resourceId: "wake_open" });
		expect(findUnclosedWakeEvents(await journal.read(), "session")).toEqual([]);
	});
});
