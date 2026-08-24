import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundTaskStateAdapter } from "../src/core/background-task/adapter.ts";
import { BackgroundTaskManager } from "../src/core/background-task/manager.ts";
import { createBackgroundTaskTool } from "../src/core/background-task/tool.ts";
import type { BackgroundTask, BackgroundTaskStatus } from "../src/core/background-task/types.ts";
import { InMemoryWakeJournal } from "../src/core/wake/journal.ts";

const directories: string[] = [];
const managers: BackgroundTaskManager[] = [];

async function waitForTerminal(manager: BackgroundTaskManager, taskId: string): Promise<BackgroundTask> {
	const terminal = new Set<BackgroundTaskStatus>(["succeeded", "failed", "cancelled"]);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const task = manager.get(taskId);
		if (task && terminal.has(task.status)) return task;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`Timed out waiting for ${taskId}`);
}

async function waitForChildPid(logPath: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const contents = await readFile(logPath, "utf8").catch(() => "");
		const match = /child=(\d+)/.exec(contents);
		if (match) return Number(match[1]);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`Timed out reading child PID from ${logPath}`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function createManager() {
	const directory = await mkdtemp(join(tmpdir(), "autopi-background-task-test-"));
	directories.push(directory);
	const journal = new InMemoryWakeJournal();
	const manager = new BackgroundTaskManager({
		allowedRoots: [directory],
		logDirectory: join(directory, "logs"),
		journal,
	});
	managers.push(manager);
	return { directory, journal, manager };
}

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.stop()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BackgroundTaskManager", () => {
	it("captures output and exit state for successful and failed commands", async () => {
		const { directory, journal, manager } = await createManager();
		const succeeded = await manager.start({
			sessionId: "session",
			command: "node -e \"console.log('task-ok')\"",
			cwd: directory,
		});
		const successState = await waitForTerminal(manager, succeeded.id);
		expect(successState.status).toBe("succeeded");
		expect(successState.exitCode).toBe(0);
		expect(await readFile(successState.logPath, "utf8")).toContain("task-ok");

		const failed = await manager.start({
			sessionId: "session",
			command: 'node -e "process.exit(7)"',
			cwd: directory,
		});
		const failureState = await waitForTerminal(manager, failed.id);
		expect(failureState.status).toBe("failed");
		expect(failureState.exitCode).toBe(7);
		expect((await journal.read()).map((event) => event.kind)).toEqual([
			"accepted",
			"completed",
			"accepted",
			"rejected",
		]);
	});

	it("cancels a running process tree and exposes terminal state to the monitor", async () => {
		const { directory, manager } = await createManager();
		const started = await manager.start({
			sessionId: "session",
			command:
				"node -e \"const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('child='+child.pid);setInterval(()=>{},1000)\"",
			cwd: directory,
		});
		const childPid = await waitForChildPid(started.logPath);
		expect(processIsAlive(childPid)).toBe(true);
		await manager.cancel(started.id, "session");
		const cancelled = await waitForTerminal(manager, started.id);
		expect(cancelled.status).toBe("cancelled");
		const deadline = Date.now() + 5_000;
		while (processIsAlive(childPid) && Date.now() < deadline) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
		}
		expect(processIsAlive(childPid)).toBe(false);
		const observation = await createBackgroundTaskStateAdapter(manager).observe({ taskId: started.id });
		expect(observation.fields.finished).toBe(true);
		expect(observation.fields.status).toBe("cancelled");
	}, 15_000);

	it("emits one terminal event when runtime shutdown cancels a task", async () => {
		const { directory, journal, manager } = await createManager();
		const terminalEvents: BackgroundTask[] = [];
		manager.subscribe((event) => {
			if (["succeeded", "failed", "cancelled"].includes(event.task.status)) terminalEvents.push(event.task);
		});
		const started = await manager.start({
			sessionId: "session",
			command: 'node -e "setInterval(() => {}, 1000)"',
			cwd: directory,
		});
		await manager.stop();
		expect((await waitForTerminal(manager, started.id)).status).toBe("cancelled");
		expect(terminalEvents.filter((task) => task.id === started.id)).toHaveLength(1);
		expect((await journal.read()).at(-1)).toEqual(
			expect.objectContaining({ kind: "revoked", resourceId: started.id }),
		);
	});

	it("scopes tool access to the owning session and project root", async () => {
		const { directory, manager } = await createManager();
		const tool = createBackgroundTaskTool(manager, directory);
		const context = {
			cwd: directory,
			sessionManager: { getSessionId: () => "session" },
		} as never;
		const result = await tool.execute(
			"call",
			{ action: "start", command: 'node -e "console.log(1)"' },
			undefined,
			undefined,
			context,
		);
		const task = (result.details as { task: BackgroundTask }).task;
		expect(task.sessionId).toBe("session");
		await expect(
			tool.execute("escape", { action: "start", command: "echo no", cwd: ".." }, undefined, undefined, context),
		).rejects.toThrow(/inside the project/);
	});
});
