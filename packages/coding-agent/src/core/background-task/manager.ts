import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	killProcessTreeSync,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { WakeJournal } from "../wake/journal.ts";
import type {
	BackgroundTask,
	BackgroundTaskListener,
	BackgroundTaskStatus,
	StartBackgroundTaskInput,
} from "./types.ts";

type ManagedBackgroundTask = {
	view: BackgroundTask;
	child: ChildProcess;
	completion: Promise<void>;
	cancelRequested: boolean;
};

export type BackgroundTaskManagerOptions = {
	allowedRoots: string[];
	logDirectory?: string;
	journal?: WakeJournal;
	shellPath?: string;
};

function isWithin(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function cloneTask(task: BackgroundTask): BackgroundTask {
	return { ...task };
}

export class BackgroundTaskManager {
	private readonly allowedRoots: string[];
	private readonly journal?: WakeJournal;
	private readonly listeners = new Set<BackgroundTaskListener>();
	private readonly logDirectory: string;
	private readonly shellPath?: string;
	private readonly tasks = new Map<string, ManagedBackgroundTask>();
	private stopping = false;

	constructor(options: BackgroundTaskManagerOptions) {
		if (options.allowedRoots.length === 0) throw new Error("BackgroundTaskManager requires an allowed root");
		this.allowedRoots = options.allowedRoots.map((root) => resolve(root));
		this.logDirectory = resolve(
			options.logDirectory ?? join(tmpdir(), "autopi-background-tasks", String(process.pid)),
		);
		this.journal = options.journal;
		this.shellPath = options.shellPath;
	}

	addAllowedRoot(root: string): void {
		const resolvedRoot = resolve(root);
		if (!this.allowedRoots.includes(resolvedRoot)) this.allowedRoots.push(resolvedRoot);
	}

	async start(input: StartBackgroundTaskInput): Promise<BackgroundTask> {
		if (this.stopping) throw new Error("Background task runtime is stopping");
		const command = input.command.trim();
		if (!command) throw new Error("Background task command cannot be empty");
		const cwd = resolve(input.cwd);
		if (!this.allowedRoots.some((root) => isWithin(cwd, root))) {
			throw new Error("Background task working directory must stay inside the current project");
		}
		await access(cwd);
		await mkdir(this.logDirectory, { recursive: true });

		const id = `task_${randomUUID()}`;
		const logPath = join(this.logDirectory, `${id}.log`);
		const shell = getShellConfig(this.shellPath);
		const commandFromStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
			cwd,
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		if (!child.pid) {
			child.kill();
			throw new Error("Background task process did not expose a PID");
		}

		const now = new Date().toISOString();
		const task: ManagedBackgroundTask = {
			view: {
				id,
				sessionId: input.sessionId,
				command,
				cwd,
				pid: child.pid,
				status: "running",
				logPath,
				createdAt: now,
				updatedAt: now,
			},
			child,
			completion: Promise.resolve(),
			cancelRequested: false,
		};
		this.tasks.set(id, task);
		trackDetachedChildPid(child.pid);
		await this.journal?.append({
			kind: "accepted",
			resourceId: id,
			target: { id: input.sessionId },
			data: { kind: "background_task", command, cwd, logPath },
		});

		const log = createWriteStream(logPath, { encoding: "utf8", flags: "wx" });
		child.stdout?.pipe(log, { end: false });
		child.stderr?.pipe(log, { end: false });
		task.completion = waitForChildProcess(child).then(
			async (exitCode) => {
				await new Promise<void>((resolvePromise) => log.end(resolvePromise));
				const status: BackgroundTaskStatus = task.cancelRequested
					? "cancelled"
					: exitCode === 0
						? "succeeded"
						: "failed";
				this.finish(task, status, exitCode ?? undefined);
				await this.journal?.append({
					kind: status === "succeeded" ? "completed" : status === "cancelled" ? "cancelled" : "rejected",
					resourceId: id,
					data: { kind: "background_task", exitCode: exitCode ?? null, logPath },
				});
			},
			async (error: unknown) => {
				await new Promise<void>((resolvePromise) => log.end(resolvePromise));
				const message = error instanceof Error ? error.message : String(error);
				this.finish(task, task.cancelRequested ? "cancelled" : "failed", undefined, message);
				await this.journal?.append({
					kind: task.cancelRequested ? "cancelled" : "rejected",
					resourceId: id,
					error: { message },
					data: { kind: "background_task", logPath },
				});
			},
		);
		this.emit(task.view);
		return cloneTask(task.view);
	}

	get(taskId: string): BackgroundTask | undefined {
		const task = this.tasks.get(taskId);
		return task ? cloneTask(task.view) : undefined;
	}

	list(sessionId?: string, includeTerminal = true): BackgroundTask[] {
		return [...this.tasks.values()]
			.map((task) => task.view)
			.filter((task) => sessionId === undefined || task.sessionId === sessionId)
			.filter((task) => includeTerminal || task.status === "running" || task.status === "cancelling")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.map(cloneTask);
	}

	async cancel(taskId: string, sessionId?: string): Promise<BackgroundTask> {
		const task = this.tasks.get(taskId);
		if (!task || (sessionId !== undefined && task.view.sessionId !== sessionId)) {
			throw new Error(`Background task not found: ${taskId}`);
		}
		if (task.view.status !== "running" && task.view.status !== "cancelling") return cloneTask(task.view);
		if (!task.cancelRequested) {
			task.cancelRequested = true;
			task.view.status = "cancelling";
			task.view.updatedAt = new Date().toISOString();
			this.emit(task.view);
			if (process.platform === "win32") {
				// taskkill /T must observe the still-live root before it can enumerate
				// descendants. Wait for that tree walk before applying a root-only fallback.
				if (!killProcessTreeSync(task.view.pid)) task.child.kill("SIGTERM");
			} else {
				killProcessTree(task.view.pid);
				task.child.kill("SIGTERM");
			}
		}
		await Promise.race([task.completion, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
		return cloneTask(task.view);
	}

	subscribe(listener: BackgroundTaskListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		const active = [...this.tasks.values()].filter(
			(task) => task.view.status === "running" || task.view.status === "cancelling",
		);
		await Promise.allSettled(active.map((task) => this.cancel(task.view.id)));
		await Promise.allSettled(
			active.map((task) =>
				this.journal?.append({
					kind: "revoked",
					resourceId: task.view.id,
					data: {
						kind: "background_task",
						reason: "runtime_stopped",
						status: task.view.status,
						logPath: task.view.logPath,
					},
				}),
			),
		);
		this.listeners.clear();
	}

	private finish(task: ManagedBackgroundTask, status: BackgroundTaskStatus, exitCode?: number, error?: string): void {
		untrackDetachedChildPid(task.view.pid);
		const endedAt = new Date().toISOString();
		task.view.status = status;
		task.view.updatedAt = endedAt;
		task.view.endedAt = endedAt;
		if (exitCode !== undefined) task.view.exitCode = exitCode;
		if (error) task.view.error = error;
		this.emit(task.view);
	}

	private emit(task: BackgroundTask): void {
		const event = { type: "changed" as const, task: cloneTask(task) };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// UI listeners must not interrupt process management.
			}
		}
	}
}
