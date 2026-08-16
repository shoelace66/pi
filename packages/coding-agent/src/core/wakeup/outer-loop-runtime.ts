import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { FileStateAdapter } from "./adapters/file-state.ts";
import { createFileStateAdapter } from "./adapters/file-state.ts";
import type { ProcessStateAdapter } from "./adapters/process-state.ts";
import { createProcessStateAdapter } from "./adapters/process-state.ts";
import { AgentWakeService } from "./agent-wake.ts";
import { createOuterLoopClockExtension } from "./clock-extension.ts";
import { type InMemoryWakeStats, InMemoryWakeStore } from "./in-memory-wake-store.ts";
import { MonitorRegistry } from "./monitor-registry.ts";
import { createOuterLoopTool } from "./outer-loop-tool.ts";
import type { WakeJob } from "./types.ts";
import { findUnclosedWakeEvents, InMemoryWakeJournal, JsonlWakeJournal, type WakeJournal } from "./wake-journal.ts";
import { WakeRunner } from "./wake-runner.ts";
import { WakeScheduler } from "./wake-scheduler.ts";

export type OuterLoopEvent =
	| { type: "changed"; stats: InMemoryWakeStats }
	| { type: "wake_started"; job: WakeJob }
	| { type: "wake_finished"; job: WakeJob };

export type OuterLoopListener = (event: OuterLoopEvent) => void;

class SessionMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}
}

/**
 * Owns the process-local outer loop and connects it to the host's sessions.
 * The agent loop itself remains in @earendil-works/pi-agent-core.
 */
export class OuterLoopRuntime {
	readonly store: InMemoryWakeStore;
	readonly monitorRegistry: MonitorRegistry;
	readonly scheduler: WakeScheduler;
	private readonly allowedRoot: string;
	private readonly fileStateAdapter: FileStateAdapter;
	private readonly processStateAdapter: ProcessStateAdapter;
	private readonly mutexes = new Map<string, SessionMutex>();
	private readonly liveSessions = new Map<string, AgentSession>();
	private readonly temporarySessions = new Map<string, AgentSession>();
	private readonly listeners = new Set<OuterLoopListener>();
	private readonly recoveryNoticesDelivered = new Set<string>();
	private readonly runner: WakeRunner;
	readonly wakeService: AgentWakeService;
	readonly journal: WakeJournal;
	private lastEmittedStats?: InMemoryWakeStats;
	private started = false;

	constructor(options: {
		cwd: string;
		store?: InMemoryWakeStore;
		checkIntervalMs?: number;
		createSession?: (sessionFile: string, cwd: string) => Promise<AgentSession>;
		createToolForSession?: (sessionFile: string, cwd: string) => ToolDefinition | undefined;
		agentDir?: string;
		journal?: WakeJournal;
	}) {
		this.allowedRoot = resolve(options.cwd);
		this.journal =
			options.journal ??
			(options.agentDir ? new JsonlWakeJournal({ agentDir: options.agentDir }) : new InMemoryWakeJournal());
		this.store = options.store ?? new InMemoryWakeStore({ journal: this.journal });
		this.monitorRegistry = new MonitorRegistry();
		this.fileStateAdapter = createFileStateAdapter({ allowedRoots: [this.allowedRoot] });
		this.processStateAdapter = createProcessStateAdapter();
		this.monitorRegistry.register(this.fileStateAdapter);
		this.monitorRegistry.register(this.processStateAdapter);
		this.wakeService = new AgentWakeService({
			journal: this.journal,
			resolver: {
				resolve: async (target) => {
					const file = target.session.file;
					const existing = this.liveSessions.get(file) ?? this.temporarySessions.get(file);
					if (existing) return { session: existing };
					const session = options.createSession
						? await options.createSession(file, target.session.cwd)
						: (
								await createAgentSession({
									sessionManager: SessionManager.open(file, undefined, target.session.cwd),
									cwd: target.session.cwd,
									customTools: (() => {
										const tool =
											options.createToolForSession?.(file, target.session.cwd) ??
											this.createTool(target.session.cwd);
										return tool ? [tool] : [];
									})(),
								})
							).session;
					this.temporarySessions.set(file, session);
					return {
						session,
						release: () => {
							if (this.temporarySessions.get(file) === session) {
								this.temporarySessions.delete(file);
								session.dispose();
							}
						},
					};
				},
			},
		});
		this.runner = new WakeRunner({
			store: this.store,
			workerId: `outer-loop-${randomUUID()}`,
			allowedSessionRoot: undefined,
			wakeService: this.wakeService,
			runExclusive: (sessionFile, _cwd, task) => this.mutex(sessionFile).run(task),
			onRunStarted: (job) => this.emit({ type: "wake_started", job }),
			onRunFinished: (job) => this.emit({ type: "wake_finished", job }),
		});
		this.scheduler = new WakeScheduler({
			store: this.store,
			monitorRegistry: this.monitorRegistry,
			runner: this.runner,
			checkIntervalMs: options.checkIntervalMs,
			onChanged: () => this.emitStatsChanged(),
		});
	}

	private mutex(sessionFile: string): SessionMutex {
		let mutex = this.mutexes.get(sessionFile);
		if (!mutex) {
			mutex = new SessionMutex();
			this.mutexes.set(sessionFile, mutex);
		}
		return mutex;
	}

	createTool(projectRoot = this.allowedRoot): ToolDefinition {
		const root = resolve(projectRoot);
		this.fileStateAdapter.addAllowedRoot(root);
		return createOuterLoopTool({
			store: this.store,
			monitorRegistry: this.monitorRegistry,
			allowedRoot: root,
			sampleMonitor: (job) => this.scheduler.sampleNow(job),
			requestRun: () => setTimeout(() => void this.scheduler.requestTick(), 0),
			onChanged: () => this.emitStatsChanged(),
		});
	}

	createClockExtension(getSessionId: () => string) {
		return createOuterLoopClockExtension(this.store, getSessionId);
	}

	async cancelByUser(input: { wakeId: string; note?: string }): Promise<{
		status: "cancelled" | "cancel_requested" | "already_terminal" | "not_found";
		notification: "immediate" | "next_turn";
		journalSeq: number;
	}> {
		const result = await this.store.cancelByUser(input.wakeId, input.note);
		if (result.job && input.note && result.status !== "already_terminal" && result.status !== "not_found") {
			const job = result.job;
			await this.wakeService.wake({
				requestId: `user-cancel:${job.id}:${job.updatedAt}`,
				target: { kind: "pi_session", session: job.session },
				source: { kind: "user_cancel", wakeId: job.id, note: input.note },
				job,
				message: input.note,
			});
		}
		const journalSeq = await this.journal.append({
			kind:
				result.status === "not_found"
					? "rejected"
					: result.status === "already_terminal"
						? "rejected"
						: result.status === "cancel_requested"
							? "queued"
							: "cancelled",
			wakeId: input.wakeId,
			data: { note: input.note, status: result.status } as never,
		});
		this.emitStatsChanged();
		return { ...result, journalSeq };
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.scheduler.start();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		await this.scheduler.stop();
		for (const session of this.temporarySessions.values()) session.dispose();
		this.temporarySessions.clear();
		this.liveSessions.clear();
		this.listeners.clear();
	}

	bindSession(session: AgentSession): void {
		this.fileStateAdapter.addAllowedRoot(session.sessionManager.getCwd());
		if (session.sessionFile) this.liveSessions.set(session.sessionFile, session);
		void this.deliverRecoveryNotice(session);
		this.emitStatsChanged();
	}

	private async deliverRecoveryNotice(session: AgentSession): Promise<void> {
		try {
			const notices = findUnclosedWakeEvents(
				await this.journal.read(),
				session.sessionManager.getSessionId(),
				this.journal.path,
			);
			for (const notice of notices) {
				const key = `${session.sessionManager.getSessionId()}:${notice.wakeId}`;
				if (this.recoveryNoticesDelivered.has(key)) continue;
				const content =
					`Outer Loop recovery notice: wake ${notice.wakeId} was left open after the previous process ended ` +
					`(${notice.lastKind}). Scheduled wake jobs are not automatically resumed.` +
					` Journal: ${notice.journalPath ?? "in-memory"}`;
				await session.sendCustomMessage(
					{
						customType: "outer_loop_recovery_notice",
						content: [{ type: "text", text: content }],
						display: false,
						details: notice,
					},
					session.isStreaming ? { deliverAs: "nextTurn" } : { triggerTurn: false },
				);
				this.recoveryNoticesDelivered.add(key);
				await this.journal.append({
					kind: "recovery_notice_delivered",
					wakeId: notice.wakeId,
					data: { journalPath: notice.journalPath ?? "in-memory", lastKind: notice.lastKind } as never,
				});
			}
		} catch {
			// Recovery is advisory; a read-only or unavailable journal must not stop Pi startup.
		}
	}

	unbindSession(sessionFile?: string): void {
		if (sessionFile) this.liveSessions.delete(sessionFile);
		else this.liveSessions.clear();
	}

	async runExclusive<T>(sessionFile: string, task: () => Promise<T>): Promise<T> {
		return this.mutex(sessionFile).run(task);
	}

	subscribe(listener: OuterLoopListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getStats(): InMemoryWakeStats {
		return this.store.getStats();
	}

	private emitStatsChanged(): void {
		const stats = this.store.getStats();
		const previous = this.lastEmittedStats;
		if (
			previous &&
			previous.armed === stats.armed &&
			previous.ready === stats.ready &&
			previous.running === stats.running &&
			previous.blocked === stats.blocked &&
			previous.monitorErrors === stats.monitorErrors &&
			previous.terminal === stats.terminal
		) {
			return;
		}
		this.lastEmittedStats = { ...stats };
		this.emit({ type: "changed", stats });
	}

	private emit(event: OuterLoopEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* UI listeners must not stop the scheduler. */
			}
		}
	}
}

export type { InMemoryWakeStats } from "./in-memory-wake-store.ts";
