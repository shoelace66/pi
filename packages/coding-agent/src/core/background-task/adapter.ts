import type { MonitorAdapter } from "../outer-loop/monitor-registry.ts";
import type { JsonValue, MonitorObservation } from "../outer-loop/types.ts";
import type { BackgroundTaskManager } from "./manager.ts";

export class BackgroundTaskStateAdapter implements MonitorAdapter {
	readonly name = "background_task_state";
	private readonly manager: BackgroundTaskManager;

	constructor(manager: BackgroundTaskManager) {
		this.manager = manager;
	}

	async observe(source: Record<string, JsonValue>, signal?: AbortSignal): Promise<MonitorObservation> {
		if (signal?.aborted) throw new Error("Background task observation was aborted");
		const taskId = source.taskId;
		if (typeof taskId !== "string" || !taskId) {
			throw new Error("background_task_state source.taskId must be a non-empty string");
		}
		const task = this.manager.get(taskId);
		if (!task) throw new Error(`Background task not found: ${taskId}`);
		const fields: Record<string, JsonValue> = {
			taskId: task.id,
			pid: task.pid,
			status: task.status,
			finished: task.status === "succeeded" || task.status === "failed" || task.status === "cancelled",
			logPath: task.logPath,
		};
		if (task.exitCode !== undefined) fields.exitCode = task.exitCode;
		if (task.endedAt) fields.endedAt = task.endedAt;
		if (task.error) fields.error = task.error;
		return {
			observedAt: new Date().toISOString(),
			fields,
			summary:
				task.exitCode === undefined
					? `Background task ${task.id}: ${task.status}`
					: `Background task ${task.id}: ${task.status} (exit code ${task.exitCode})`,
		};
	}
}

export function createBackgroundTaskStateAdapter(manager: BackgroundTaskManager): BackgroundTaskStateAdapter {
	return new BackgroundTaskStateAdapter(manager);
}
