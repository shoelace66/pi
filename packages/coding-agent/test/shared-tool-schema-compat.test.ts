import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-task/manager.ts";
import { createBackgroundTaskTool } from "../src/core/background-task/tool.ts";
import { InMemoryWakeStore } from "../src/core/outer-loop/in-memory-wake-store.ts";
import { MonitorRegistry } from "../src/core/outer-loop/monitor-registry.ts";
import { createOuterLoopTool } from "../src/core/outer-loop/tool.ts";

type PreparableTool = Tool & {
	prepareArguments?: (args: unknown) => unknown;
};

function asSchema(value: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function prepare(tool: PreparableTool, input: unknown): Record<string, unknown> {
	if (!tool.prepareArguments) throw new Error(`${tool.name} does not define prepareArguments`);
	const prepared = tool.prepareArguments(input);
	if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
		throw new Error(`${tool.name} prepared arguments must be an object`);
	}
	return prepared as Record<string, unknown>;
}

function validatePrepared(tool: PreparableTool, input: unknown): Record<string, unknown> {
	const prepared = prepare(tool, input);
	validateToolArguments(tool, {
		type: "toolCall",
		id: "schema-compat",
		name: tool.name,
		arguments: prepared,
	});
	return prepared;
}

function createTools() {
	const allowedRoot = process.cwd();
	const outerLoop = createOuterLoopTool({
		store: new InMemoryWakeStore(),
		monitorRegistry: new MonitorRegistry(),
		allowedRoot,
	});
	const backgroundTask = createBackgroundTaskTool(
		new BackgroundTaskManager({ allowedRoots: [allowedRoot] }),
		allowedRoot,
	);
	return { outerLoop, backgroundTask };
}

const objective = { reason: "A future result is required", objective: "Continue after observing it" };
const timeout = { kind: "after", value: "00:05:00", onTimeout: "wake" };

describe("shared tool schema compatibility", () => {
	it("publishes outer_loop and background_task as flat root objects", () => {
		const { outerLoop, backgroundTask } = createTools();
		const outerSchema = asSchema(outerLoop.parameters);
		const backgroundSchema = asSchema(backgroundTask.parameters);

		for (const schema of [outerSchema, backgroundSchema]) {
			expect(schema.type).toBe("object");
			expect(schema).not.toHaveProperty("anyOf");
			expect(schema).not.toHaveProperty("oneOf");
			expect(schema).not.toHaveProperty("allOf");
			expect(schema.required).toEqual(["action"]);
			expect(schema.properties).toBeTypeOf("object");
		}

		const outerProperties = outerSchema.properties as Record<string, Record<string, unknown>>;
		const backgroundProperties = backgroundSchema.properties as Record<string, Record<string, unknown>>;
		expect(outerProperties.action?.type).toBe("string");
		expect(outerProperties.action?.enum).toEqual([
			"wait_time",
			"wait_file",
			"wait_process",
			"wait_task",
			"wait_custom",
			"list",
			"cancel",
		]);
		expect(backgroundProperties.action?.type).toBe("string");
		expect(backgroundProperties.action?.enum).toEqual(["start", "status", "list", "cancel"]);
	});

	it("accepts and schema-validates every outer_loop action", () => {
		const { outerLoop } = createTools();
		const inputs = [
			{ action: "wait_time", ...objective, after: "00:01:00" },
			{ action: "wait_time", ...objective, at: "2030-01-01T00:00:00Z" },
			{ action: "wait_file", ...objective, path: "result.txt", event: "exists", timeout },
			{ action: "wait_process", ...objective, pid: 42, event: "exited", timeout, pollInterval: "00:00:30" },
			{ action: "wait_task", ...objective, taskId: "task_1", event: "finished", timeout },
			{ action: "list", includeTerminal: true },
			{ action: "cancel", wakeId: "wake_1" },
		];

		for (const input of inputs) expect(() => validatePrepared(outerLoop, input)).not.toThrow();
		expect(prepare(outerLoop, inputs[0]).after).toBe(60_000);
		expect(prepare(outerLoop, inputs[3]).pollInterval).toBe(30_000);
	});

	it("accepts and schema-validates every background_task action", () => {
		const { backgroundTask } = createTools();
		const inputs = [
			{ action: "start", command: "node worker.js", cwd: "." },
			{ action: "status", taskId: "task_1" },
			{ action: "list", includeTerminal: true },
			{ action: "cancel", taskId: "task_1" },
		];

		for (const input of inputs) expect(() => validatePrepared(backgroundTask, input)).not.toThrow();
	});

	it("rejects missing and action-mismatched outer_loop fields at the execution boundary", async () => {
		const { outerLoop } = createTools();
		const invalidInputs = [
			{},
			{ action: "wait_time", ...objective },
			{ action: "wait_time", ...objective, after: "00:01:00", at: "2030-01-01T00:00:00Z" },
			{ action: "wait_file", ...objective, event: "exists", timeout },
			{ action: "wait_process", ...objective, pid: 42, event: "finished", timeout },
			{ action: "wait_task", ...objective, taskId: "task_1", event: "exited", timeout },
			{ action: "list", path: "not-valid-for-list" },
			{ action: "cancel", wakeId: "" },
		];

		for (const input of invalidInputs) {
			await expect(
				outerLoop.execute("outer-invalid", input as never, undefined, undefined, {} as never),
			).rejects.toThrow(/outer_loop/);
		}
	});

	it("rejects missing and action-mismatched background_task fields before execution", () => {
		const { backgroundTask } = createTools();
		const invalidInputs = [
			{},
			{ action: "start" },
			{ action: "start", command: "   " },
			{ action: "status" },
			{ action: "status", taskId: "task_1", command: "wrong-action-field" },
			{ action: "list", taskId: "task_1" },
			{ action: "cancel", taskId: "" },
		];

		for (const input of invalidInputs) expect(() => prepare(backgroundTask, input)).toThrow(/background_task/);
	});

	it("applies the action parser to direct execute calls as defense in depth", async () => {
		const { outerLoop, backgroundTask } = createTools();
		await expect(
			outerLoop.execute(
				"outer-invalid",
				{ action: "list", path: "wrong-action-field" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/outer_loop\.list/);
		await expect(
			backgroundTask.execute(
				"background-invalid",
				{ action: "status", taskId: "task_1", command: "wrong-action-field" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/background_task\.status/);
	});
});
