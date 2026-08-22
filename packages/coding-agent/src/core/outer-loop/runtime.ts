import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { findUnclosedWakeEvents, type WakeJournal } from "../wake/journal.ts";
import type { WakeRuntime } from "../wake/runtime.ts";
import type { WakeRegistration } from "../wake/types.ts";
import type { FileStateAdapter } from "./adapters/file-state.ts";
import { createFileStateAdapter } from "./adapters/file-state.ts";
import type { ProcessStateAdapter } from "./adapters/process-state.ts";
import { createProcessStateAdapter } from "./adapters/process-state.ts";
import { createOuterLoopClockExtension } from "./clock-extension.ts";
import { type InMemoryWakeStats, InMemoryWakeStore } from "./in-memory-wake-store.ts";
import { MonitorRegistry } from "./monitor-registry.ts";
import { createOuterLoopTool } from "./tool.ts";
import type { WakeJob } from "./types.ts";
import { WakeRunner } from "./wake-runner.ts";
import { WakeScheduler } from "./wake-scheduler.ts";

export type OuterLoopEvent =
	| { type: "changed"; stats: InMemoryWakeStats }
	| { type: "wake_started"; job: WakeJob }
	| { type: "wake_finished"; job: WakeJob };

export type OuterLoopListener = (event: OuterLoopEvent) => void;

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
	private readonly wakeRuntime: WakeRuntime;
	private readonly stopWakeRuntime: boolean;
	private readonly registrations = new Map<string, WakeRegistration>();
	private readonly listeners = new Set<OuterLoopListener>();
	private readonly recoveryNoticesDelivered = new Set<string>();
	private readonly runner: WakeRunner;
	readonly journal: WakeJournal;
	private lastEmittedStats?: InMemoryWakeStats;
	private started = false;

	constructor(options: {
		cwd: string;
		store?: InMemoryWakeStore;
		checkIntervalMs?: number;
		wakeRuntime: WakeRuntime;
		stopWakeRuntime?: boolean;
		journal?: WakeJournal;
	}) {
		this.allowedRoot = resolve(options.cwd);
		this.wakeRuntime = options.wakeRuntime;
		this.stopWakeRuntime = options.stopWakeRuntime ?? false;
		this.journal = options.journal ?? options.wakeRuntime.journal;
		this.store = options.store ?? new InMemoryWakeStore({ journal: this.journal });
		this.monitorRegistry = new MonitorRegistry();
		this.fileStateAdapter = createFileStateAdapter({ allowedRoots: [this.allowedRoot] });
		this.processStateAdapter = createProcessStateAdapter();
		this.monitorRegistry.register(this.fileStateAdapter);
		this.monitorRegistry.register(this.processStateAdapter);
		this.runner = new WakeRunner({
			store: this.store,
			workerId: `outer-loop-${randomUUID()}`,
			allowedSessionRoot: undefined,
			resolveRegistration: (job) => this.registrationForAttempt(job),
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

	createTool(projectRoot = this.allowedRoot): ToolDefinition {
		const root = resolve(projectRoot);
		this.fileStateAdapter.addAllowedRoot(root);
		return createOuterLoopTool({
			store: this.store,
			monitorRegistry: this.monitorRegistry,
			allowedRoot: root,
			sampleMonitor: (job) => this.scheduler.sampleNow(job),
			registerWake: (job) => this.registerInitial(job),
			cancelWake: (wakeId, reason) => this.cancelRegistrations(wakeId, reason ?? "Outer Loop cancelled"),
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
		await this.cancelRegistrations(input.wakeId, input.note ?? "Cancelled by user");
		if (result.job && input.note && result.status !== "already_terminal" && result.status !== "not_found") {
			const job = result.job;
			const registration = await this.wakeRuntime.contextFor(job.session).register({
				requestKey: `user-cancel:${job.id}:${job.updatedAt}`,
				producer: { id: "outer_loop", name: "Outer Loop" },
				reason: "The user cancelled an outer-loop job.",
				objective: "Acknowledge the cancellation and do not continue the cancelled work.",
			});
			await registration.emit({
				eventId: `user-cancel:${job.id}:${job.updatedAt}`,
				message: input.note,
				data: { wakeId: job.id, cancellation: "user" },
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
			resourceId: input.wakeId,
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
		if (!this.started) {
			if (this.stopWakeRuntime) await this.wakeRuntime.stop();
			return;
		}
		this.started = false;
		await this.scheduler.stop();
		await Promise.allSettled(
			[...this.registrations.values()].map((registration) => registration.cancel("Outer Loop stopped")),
		);
		this.registrations.clear();
		if (this.stopWakeRuntime) await this.wakeRuntime.stop();
		this.listeners.clear();
	}

	bindSession(session: AgentSession): void {
		this.fileStateAdapter.addAllowedRoot(session.sessionManager.getCwd());
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
				const key = `${session.sessionManager.getSessionId()}:${notice.resourceId}`;
				if (this.recoveryNoticesDelivered.has(key)) continue;
				const content =
					`Outer Loop recovery notice: wake ${notice.resourceId} was left open after the previous process ended ` +
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
					resourceId: notice.resourceId,
					data: { journalPath: notice.journalPath ?? "in-memory", lastKind: notice.lastKind } as never,
				});
			}
		} catch {
			// Recovery is advisory; a read-only or unavailable journal must not stop Pi startup.
		}
	}

	unbindSession(sessionFile?: string): void {
		this.wakeRuntime.unbindSession(sessionFile);
	}

	async runExclusive<T>(sessionFile: string, task: () => Promise<T>): Promise<T> {
		return this.wakeRuntime.runExclusive(sessionFile, task);
	}

	private registrationKey(wakeId: string, attempt: number): string {
		return `${wakeId}:${attempt}`;
	}

	private async registerInitial(job: WakeJob): Promise<void> {
		await this.getOrCreateRegistration(job, Math.max(1, job.runAttempt + 1));
	}

	private async registrationForAttempt(job: WakeJob): Promise<WakeRegistration> {
		return this.getOrCreateRegistration(job, job.runAttempt);
	}

	private async getOrCreateRegistration(job: WakeJob, attempt: number): Promise<WakeRegistration> {
		const key = this.registrationKey(job.id, attempt);
		const existing = this.registrations.get(key);
		if (existing && !existing.signal.aborted) return existing;
		const registration = await this.wakeRuntime.contextFor(job.session).register({
			requestKey: `outer-loop:${key}`,
			producer: { id: "outer_loop", name: "Outer Loop" },
			reason: job.reason,
			objective: job.objective,
			checkFirst: job.checkFirst,
		});
		this.registrations.set(key, registration);
		void registration.outcome.finally(() => {
			if (this.registrations.get(key) === registration) this.registrations.delete(key);
		});
		return registration;
	}

	private async cancelRegistrations(wakeId: string, reason: string): Promise<void> {
		const matches = [...this.registrations.entries()].filter(([key]) => key.startsWith(`${wakeId}:`));
		await Promise.allSettled(matches.map(([, registration]) => registration.cancel(reason)));
		for (const [key] of matches) this.registrations.delete(key);
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
