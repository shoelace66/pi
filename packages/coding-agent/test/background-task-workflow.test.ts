import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-task/manager.ts";
import type { BackgroundTask } from "../src/core/background-task/types.ts";

const directories: string[] = [];
const managers: BackgroundTaskManager[] = [];

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "autopi-workflow-"));
	directories.push(directory);
	const manager = new BackgroundTaskManager({ allowedRoots: [directory], logDirectory: join(directory, "logs") });
	managers.push(manager);
	return { directory, manager };
}

async function startScript(
	manager: BackgroundTaskManager,
	directory: string,
	name: string,
	source: string,
): Promise<BackgroundTask> {
	const script = join(directory, name);
	await writeFile(script, source, "utf8");
	return manager.start({ sessionId: "workflow", command: `node "${script}"`, cwd: directory });
}

async function waitForTerminal(manager: BackgroundTaskManager, taskId: string): Promise<BackgroundTask> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const task = manager.get(taskId);
		if (task && ["succeeded", "failed", "cancelled"].includes(task.status)) return task;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`Timed out waiting for ${taskId}`);
}

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.stop()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("background task workflow acceptance", () => {
	it("starts testing only after successful training and produces the requested report", async () => {
		const { directory, manager } = await fixture();
		const trace = join(directory, "trace.txt");
		const marker = join(directory, "trained.ok");
		const report = join(directory, "reports", "eval.md");
		const training = await startScript(
			manager,
			directory,
			"train.mjs",
			`import { appendFile, writeFile } from "node:fs/promises";
await new Promise((resolve) => setTimeout(resolve, 120));
await appendFile(${JSON.stringify(trace)}, "train-finished\\n");
await writeFile(${JSON.stringify(marker)}, "ok");`,
		);
		expect((await waitForTerminal(manager, training.id)).status).toBe("succeeded");

		const testing = await startScript(
			manager,
			directory,
			"test.mjs",
			`import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
await access(${JSON.stringify(marker)});
await appendFile(${JSON.stringify(trace)}, "test-started\\n");
await mkdir(${JSON.stringify(join(directory, "reports"))}, { recursive: true });
await writeFile(${JSON.stringify(report)}, "# Evaluation\\n\\naccuracy: 0.90\\n");`,
		);
		expect((await waitForTerminal(manager, testing.id)).status).toBe("succeeded");
		expect(await readFile(trace, "utf8")).toBe("train-finished\ntest-started\n");
		expect(await readFile(report, "utf8")).toContain("accuracy: 0.90");
	});

	it("does not start testing after training fails", async () => {
		const { directory, manager } = await fixture();
		const report = join(directory, "reports", "eval.md");
		const training = await startScript(manager, directory, "train-fail.mjs", "process.exit(7);");
		const state = await waitForTerminal(manager, training.id);
		expect(state).toEqual(expect.objectContaining({ status: "failed", exitCode: 7 }));
		expect(manager.list("workflow")).toHaveLength(1);
		await expect(access(report)).rejects.toThrow();
	});

	it("records a test failure summary without inventing metrics", async () => {
		const { directory, manager } = await fixture();
		const report = join(directory, "eval-failure.md");
		const testing = await startScript(manager, directory, "test-fail.mjs", "process.exit(9);");
		const state = await waitForTerminal(manager, testing.id);
		expect(state).toEqual(expect.objectContaining({ status: "failed", exitCode: 9 }));
		await writeFile(
			report,
			`# Evaluation failed\n\nTest command exited with code ${state.exitCode}.\n\nLog: ${state.logPath}\n`,
			"utf8",
		);
		const summary = await readFile(report, "utf8");
		expect(summary).toContain("exited with code 9");
		expect(summary).not.toMatch(/accuracy|precision|recall|mAP/i);
	});
});
