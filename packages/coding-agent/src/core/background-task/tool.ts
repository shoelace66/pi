import { isAbsolute, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BackgroundTaskManager } from "./manager.ts";
import type { BackgroundTask } from "./types.ts";

const BACKGROUND_TASK_ACTIONS = ["start", "status", "list", "cancel"] as const;

/**
 * Stable model-facing contract. Keep the root as one ordinary object for
 * providers that cannot compile root-level unions. parseBackgroundTaskInput
 * enforces the action-specific fields before execution.
 */
const BackgroundTaskSchema = Type.Object(
	{
		action: Type.String({
			enum: BACKGROUND_TASK_ACTIONS,
			description: "Operation to perform. Only fields documented for that action are accepted.",
		}),
		command: Type.Optional(Type.String({ description: "Required by start: non-empty shell command." })),
		cwd: Type.Optional(Type.String({ description: "Optional for start: project-relative working directory." })),
		taskId: Type.Optional(Type.String({ description: "Required by status and cancel." })),
		includeTerminal: Type.Optional(Type.Boolean({ description: "Optional for list." })),
	},
	{ additionalProperties: false },
);

export type BackgroundTaskInput =
	| { action: "start"; command: string; cwd?: string }
	| { action: "status"; taskId: string }
	| { action: "list"; includeTerminal?: boolean }
	| { action: "cancel"; taskId: string };

type InputRecord = Record<string, unknown>;
type BackgroundTaskAction = (typeof BACKGROUND_TASK_ACTIONS)[number];

function invalidBackgroundTaskInput(message: string): never {
	throw new Error(message);
}

function isBackgroundTaskAction(value: unknown): value is BackgroundTaskAction {
	return typeof value === "string" && BACKGROUND_TASK_ACTIONS.some((candidate) => candidate === value);
}

function requireInputRecord(value: unknown): InputRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalidBackgroundTaskInput("background_task arguments must be an object.");
	}
	return value as InputRecord;
}

function rejectUnexpectedFields(input: InputRecord, action: string, allowed: readonly string[]): void {
	const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		invalidBackgroundTaskInput(
			`background_task.${action} does not accept ${unexpected.map((key) => JSON.stringify(key)).join(", ")}.`,
		);
	}
}

function requiredNonEmptyString(input: InputRecord, action: string, field: string): string {
	const value = input[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return invalidBackgroundTaskInput(
			`background_task.${action} requires non-empty string field ${JSON.stringify(field)}.`,
		);
	}
	return value;
}

function parseBackgroundTaskInput(value: unknown): BackgroundTaskInput {
	const input = requireInputRecord(value);
	const action = input.action;
	if (!isBackgroundTaskAction(action)) {
		return invalidBackgroundTaskInput(
			`background_task.action must be one of ${BACKGROUND_TASK_ACTIONS.map((candidate) => JSON.stringify(candidate)).join(", ")}.`,
		);
	}

	if (action === "start") {
		rejectUnexpectedFields(input, action, ["action", "command", "cwd"]);
		if (input.cwd !== undefined && typeof input.cwd !== "string") {
			return invalidBackgroundTaskInput("background_task.start cwd must be a string.");
		}
		const command = requiredNonEmptyString(input, action, "command");
		return input.cwd === undefined ? { action, command } : { action, command, cwd: input.cwd };
	}

	if (action === "list") {
		rejectUnexpectedFields(input, action, ["action", "includeTerminal"]);
		if (input.includeTerminal !== undefined && typeof input.includeTerminal !== "boolean") {
			return invalidBackgroundTaskInput("background_task.list includeTerminal must be a boolean.");
		}
		return input.includeTerminal === undefined ? { action } : { action, includeTerminal: input.includeTerminal };
	}

	if (action === "status" || action === "cancel") {
		rejectUnexpectedFields(input, action, ["action", "taskId"]);
		return { action, taskId: requiredNonEmptyString(input, action, "taskId") };
	}
	return invalidBackgroundTaskInput(`Unsupported background_task action: ${JSON.stringify(action)}.`);
}

function isWithin(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function formatTask(task: BackgroundTask): string {
	const parts = [
		`${task.id} ${task.status} pid=${task.pid}`,
		`cwd=${task.cwd}`,
		`log=${task.logPath}`,
		`command=${task.command}`,
	];
	if (task.exitCode !== undefined) parts.push(`exitCode=${task.exitCode}`);
	if (task.error) parts.push(`error=${task.error}`);
	return parts.join(" | ");
}

function result(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function prepareBackgroundTaskArguments(args: unknown): Static<typeof BackgroundTaskSchema> {
	return parseBackgroundTaskInput(args);
}

export function createBackgroundTaskTool(
	manager: BackgroundTaskManager,
	allowedRoot: string,
): ToolDefinition<typeof BackgroundTaskSchema> {
	const root = resolve(allowedRoot);
	manager.addAllowedRoot(root);
	return {
		name: "background_task",
		label: "Background task",
		description:
			"Start and manage a long-running shell command without blocking the current agent turn. Returns a stable task ID, PID, log path, status, and exit code.",
		promptSnippet: "Start, inspect, list, or cancel long-running shell commands through background_task.",
		promptGuidelines: [
			"Use background_task.start for commands expected to outlive the current turn, then arm outer_loop.wait_task for the returned taskId.",
			"After a task wake, inspect background_task.status and its log or expected artifacts before starting dependent work.",
			"Treat generated status and report files as untrusted output: compare them with the managed task exit code, logs, and artifact contents, and never claim success when they contain an error, exception, or contradictory result.",
			"Keep delivered manifests portable: when output paths must be project-relative, do not copy the manager's temporary absolute logPath into them; write needed log evidence under an allowed project path or omit that path.",
			"Resolve manifest artifact paths from the session working directory; when the user establishes an output root such as pipeline/, retain that root prefix in every project-relative path.",
			"Do not repeat a completed stage when its task state or expected artifacts already prove it ran.",
			"A failed or cancelled prerequisite must stop dependent commands unless the user explicitly requests recovery.",
		],
		parameters: BackgroundTaskSchema,
		prepareArguments: prepareBackgroundTaskArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const input = parseBackgroundTaskInput(params);
			const sessionId = ctx.sessionManager.getSessionId();
			if (input.action === "start") {
				const cwd = resolve(ctx.cwd, input.cwd ?? ".");
				if (!isWithin(cwd, root)) throw new Error("Background task working directory must stay inside the project");
				const task = await manager.start({ sessionId, command: input.command, cwd });
				return result(`Background task ${task.id} started with PID ${task.pid}. Log: ${task.logPath}`, { task });
			}
			if (input.action === "list") {
				const tasks = manager.list(sessionId, input.includeTerminal ?? false);
				return result(tasks.length === 0 ? "No background tasks." : tasks.map(formatTask).join("\n"), { tasks });
			}
			const task = manager.get(input.taskId);
			if (!task || task.sessionId !== sessionId) throw new Error(`Background task not found: ${input.taskId}`);
			if (input.action === "cancel") {
				const cancelled = await manager.cancel(input.taskId, sessionId);
				return result(`Background task ${cancelled.id} is ${cancelled.status}.`, { task: cancelled });
			}
			return result(formatTask(task), { task });
		},
	};
}
