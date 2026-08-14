import type {
	ClaimedWake,
	CreateWakeInput,
	CreateWakeResult,
	MonitorObservation,
	TriggerResult,
	WakeError,
	WakeFailure,
	WakeJob,
	WakeStatus,
	WakeStore,
} from "./types.ts";
import type { WakeJournal } from "./wake-journal.ts";
import { normalizeCreateWakeInput } from "./wake-policy.ts";

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(value?: string): string {
	return value ?? new Date().toISOString();
}

function isBeforeOrEqual(left: string, right: string): boolean {
	return new Date(left).getTime() <= new Date(right).getTime();
}

function isDueForRun(job: WakeJob, now: string): boolean {
	return (
		(job.status === "ready" || job.status === "run_retry_wait") &&
		(!job.nextRunAttemptAt || isBeforeOrEqual(job.nextRunAttemptAt, now))
	);
}

function isDueForMonitor(job: WakeJob, now: string): boolean {
	if (job.status !== "armed" || job.trigger.type !== "monitor") return false;
	if (new Date(job.trigger.timeout.at).getTime() <= new Date(now).getTime()) return true;
	if (job.trigger.delivery.mode !== "poll") return false;
	return !job.triggerRuntime?.nextCheckAt || isBeforeOrEqual(job.triggerRuntime.nextCheckAt, now);
}

function toError(failure: WakeFailure, now: string): WakeError {
	return { ...failure, at: now };
}

function makeId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type InMemoryWakeStoreOptions = {
	maxRunAttempts?: number;
	maxMonitorFailures?: number;
	journal?: WakeJournal;
};

export type InMemoryWakeStats = {
	armed: number;
	ready: number;
	running: number;
	blocked: number;
	monitorErrors: number;
	terminal: number;
};

/**
 * Process-local WakeStore. It deliberately has no persistence or filesystem
 * locking; the owning OuterLoopRuntime is the only scheduler in this process.
 */
export class InMemoryWakeStore implements WakeStore {
	private readonly jobs = new Map<string, WakeJob>();
	private readonly requestKeys = new Map<string, string>();
	private readonly maxRunAttempts: number;
	private readonly maxMonitorFailures: number;
	private readonly journal?: WakeJournal;
	private lastJournalSeq = 0;

	constructor(options: InMemoryWakeStoreOptions = {}) {
		this.maxRunAttempts = options.maxRunAttempts ?? 3;
		this.maxMonitorFailures = options.maxMonitorFailures ?? 5;
		this.journal = options.journal;
	}

	getStats(): InMemoryWakeStats {
		const stats: InMemoryWakeStats = { armed: 0, ready: 0, running: 0, blocked: 0, monitorErrors: 0, terminal: 0 };
		for (const job of this.jobs.values()) {
			if (job.status === "armed") stats.armed++;
			else if (job.status === "ready" || job.status === "run_retry_wait") stats.ready++;
			else if (job.status === "running" || job.status === "cancel_requested") stats.running++;
			else if (job.status === "blocked") stats.blocked++;
			else stats.terminal++;
			if (
				!["completed", "cancelled", "expired", "dead_letter"].includes(job.status) &&
				job.triggerRuntime?.cause === "monitor_error"
			) {
				stats.monitorErrors++;
			}
		}
		return stats;
	}

	listAll(): WakeJob[] {
		return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
	}

	private getJobOrThrow(wakeId: string): WakeJob {
		const job = this.jobs.get(wakeId);
		if (!job) throw new Error("Wake Job not found");
		return job;
	}

	private touch(job: WakeJob, now: string): void {
		job.updatedAt = now;
	}

	async createOnce(input: CreateWakeInput): Promise<CreateWakeResult> {
		const normalized = normalizeCreateWakeInput(input);
		const existingId = this.requestKeys.get(normalized.requestKey);
		if (existingId) {
			const existing = this.jobs.get(existingId);
			if (existing) return { job: clone(existing), deduplicated: true };
		}
		const now = normalized.now ?? new Date().toISOString();
		const job: WakeJob = {
			schemaVersion: 2,
			id: makeId("wake"),
			requestKey: normalized.requestKey,
			session: clone(normalized.session),
			trigger: clone(normalized.trigger),
			reason: normalized.reason,
			objective: normalized.objective,
			checkFirst: normalized.checkFirst,
			status: "armed",
			runAttempt: 0,
			maxRunAttempts: normalized.maxRunAttempts ?? this.maxRunAttempts,
			leaseGeneration: 0,
			triggerRuntime:
				normalized.trigger.type === "monitor"
					? { checkCount: 0, failureCount: 0, baselineObserved: false, consecutiveMatches: 0 }
					: undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.jobs.set(job.id, job);
		this.requestKeys.set(job.requestKey, job.id);
		const source =
			job.trigger.type === "time"
				? { kind: "timer" as const, wakeId: job.id, scheduledAt: job.trigger.dueAt }
				: { kind: "monitor" as const, wakeId: job.id, adapter: job.trigger.adapter };
		this.lastJournalSeq =
			(await this.journal?.append({
				kind: "accepted",
				wakeId: job.id,
				requestId: job.requestKey,
				source,
				target: job.session as never,
				data: job as never,
			})) ?? this.lastJournalSeq;
		return { job: clone(job), deduplicated: false };
	}

	async listBySession(sessionId: string, statuses?: WakeStatus[]): Promise<WakeJob[]> {
		const filter = statuses ? new Set(statuses) : undefined;
		return [...this.jobs.values()]
			.filter((job) => job.session.id === sessionId && (!filter || filter.has(job.status)))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map(clone);
	}

	async cancelOwned(wakeId: string, sessionId: string, now = new Date().toISOString()): Promise<WakeJob> {
		const job = this.getJobOrThrow(wakeId);
		if (job.session.id !== sessionId) throw new Error("Wake Job not found");
		if (["completed", "cancelled", "expired", "dead_letter"].includes(job.status)) return clone(job);
		job.status = job.status === "running" ? "cancel_requested" : "cancelled";
		this.touch(job, now);
		return clone(job);
	}

	async cancelByUser(
		wakeId: string,
		note?: string,
		now = new Date().toISOString(),
	): Promise<{
		status: "cancelled" | "cancel_requested" | "already_terminal" | "not_found";
		notification: "immediate" | "next_turn";
		job?: WakeJob;
		journalSeq?: number;
	}> {
		const job = this.jobs.get(wakeId);
		if (!job)
			return {
				status: "not_found",
				notification: note ? "immediate" : "next_turn",
				journalSeq: this.lastJournalSeq,
			};
		if (["completed", "cancelled", "expired", "dead_letter"].includes(job.status)) {
			return {
				status: "already_terminal",
				notification: note ? "immediate" : "next_turn",
				job: clone(job),
				journalSeq: this.lastJournalSeq,
			};
		}
		const running = job.status === "running" || job.status === "cancel_requested";
		job.status = running ? "cancel_requested" : "cancelled";
		job.cancellationNotice = { note, pending: !note, createdAt: now };
		this.touch(job, now);
		this.lastJournalSeq =
			(await this.journal?.append({
				kind: "cancelled",
				wakeId: job.id,
				data: { status: job.status, note } as never,
				at: now,
			})) ?? this.lastJournalSeq;
		return {
			status: job.status as "cancelled" | "cancel_requested",
			notification: note ? "immediate" : "next_turn",
			job: clone(job),
			journalSeq: this.lastJournalSeq,
		};
	}

	async listPendingUserNotifications(
		sessionId: string,
	): Promise<Array<{ wakeId: string; note?: string; createdAt: string }>> {
		return [...this.jobs.values()]
			.filter((job) => job.session.id === sessionId && job.cancellationNotice?.pending)
			.map((job) => ({
				wakeId: job.id,
				note: job.cancellationNotice?.note,
				createdAt: job.cancellationNotice!.createdAt,
			}));
	}

	async acknowledgeUserNotifications(sessionId: string, wakeIds: string[]): Promise<void> {
		const ids = new Set(wakeIds);
		for (const job of this.jobs.values()) {
			if (job.session.id === sessionId && ids.has(job.id) && job.cancellationNotice)
				job.cancellationNotice.pending = false;
		}
	}

	async listDueTimeJobs(now: string, limit = 100): Promise<WakeJob[]> {
		return [...this.jobs.values()]
			.filter(
				(job) => job.status === "armed" && job.trigger.type === "time" && isBeforeOrEqual(job.trigger.dueAt, now),
			)
			.slice(0, limit)
			.map(clone);
	}

	async listDueRunJobs(now: string, limit = 100): Promise<WakeJob[]> {
		return [...this.jobs.values()]
			.filter((job) => isDueForRun(job, now))
			.slice(0, limit)
			.map(clone);
	}

	async listDueMonitorJobs(now: string, limit = 100): Promise<WakeJob[]> {
		return [...this.jobs.values()]
			.filter((job) => isDueForMonitor(job, now))
			.slice(0, limit)
			.map(clone);
	}

	async listArmedMonitorJobsBySubscription(subscriptionId: string, limit = 100): Promise<WakeJob[]> {
		return [...this.jobs.values()]
			.filter(
				(job) =>
					job.status === "armed" &&
					job.trigger.type === "monitor" &&
					job.trigger.delivery.mode === "push" &&
					job.trigger.delivery.subscriptionId === subscriptionId,
			)
			.slice(0, limit)
			.map(clone);
	}

	async markReady(wakeId: string, result: TriggerResult, now = new Date().toISOString()): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || job.status !== "armed") return false;
		job.status = "ready";
		job.triggerRuntime = {
			checkCount: job.triggerRuntime?.checkCount ?? 0,
			failureCount: job.triggerRuntime?.failureCount ?? 0,
			baselineObserved: job.triggerRuntime?.baselineObserved ?? false,
			consecutiveMatches: job.triggerRuntime?.consecutiveMatches ?? 0,
			...job.triggerRuntime,
			cause: result.cause,
			evidence: result.evidence,
			monitorError: result.monitorError,
			satisfiedAt: result.satisfiedAt ?? now,
		};
		this.touch(job, now);
		await this.journal?.append({ kind: "queued", wakeId: job.id, data: { cause: result.cause } as never, at: now });
		return true;
	}

	async recordMonitorObservation(
		wakeId: string,
		observation: MonitorObservation,
		evaluation: {
			rawMatched: boolean;
			matched: boolean;
			nextBaselineObserved: boolean;
			nextConsecutiveMatches: number;
			nextBaselineFingerprint?: string;
		},
		nextCheckAt?: string,
		now = new Date().toISOString(),
	): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || job.status !== "armed" || job.trigger.type !== "monitor") return false;
		job.triggerRuntime = {
			...job.triggerRuntime,
			checkCount: (job.triggerRuntime?.checkCount ?? 0) + 1,
			failureCount: job.triggerRuntime?.failureCount ?? 0,
			baselineObserved: evaluation.nextBaselineObserved,
			consecutiveMatches: evaluation.nextConsecutiveMatches,
			baselineFingerprint: evaluation.nextBaselineFingerprint ?? job.triggerRuntime?.baselineFingerprint,
			lastObservation: observation,
			nextCheckAt,
		};
		if (evaluation.matched) {
			job.status = "ready";
			job.triggerRuntime.evidence = observation;
			job.triggerRuntime.satisfiedAt = now;
			job.triggerRuntime.cause = "monitor_match";
		}
		this.touch(job, now);
		if (evaluation.matched) {
			await this.journal?.append({
				kind: "queued",
				wakeId: job.id,
				data: { cause: "monitor_match" } as never,
				at: now,
			});
		}
		return true;
	}

	async recordMonitorFailure(
		wakeId: string,
		failure: WakeFailure,
		nextCheckAt?: string,
		now = new Date().toISOString(),
	): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || job.status !== "armed") return false;
		job.triggerRuntime = {
			...job.triggerRuntime,
			checkCount: job.triggerRuntime?.checkCount ?? 0,
			failureCount: (job.triggerRuntime?.failureCount ?? 0) + 1,
			baselineObserved: job.triggerRuntime?.baselineObserved ?? false,
			consecutiveMatches: job.triggerRuntime?.consecutiveMatches ?? 0,
			nextCheckAt,
			cause: failure.phase === "monitor" ? "monitor_error" : job.triggerRuntime?.cause,
			monitorError: failure.phase === "monitor" ? toError(failure, now) : job.triggerRuntime?.monitorError,
		};
		job.lastError = toError(failure, now);
		if (failure.requiresUser) job.status = "blocked";
		else if ((job.triggerRuntime.failureCount ?? 0) >= this.maxMonitorFailures) job.status = "dead_letter";
		this.touch(job, now);
		await this.journal?.append({
			kind: failure.requiresUser ? "blocked" : job.status === "dead_letter" ? "rejected" : "retryable",
			wakeId: job.id,
			error: failure as never,
			at: now,
		});
		return true;
	}

	async expire(wakeId: string, now = new Date().toISOString()): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || job.status !== "armed") return false;
		job.status = "expired";
		job.triggerRuntime = {
			checkCount: job.triggerRuntime?.checkCount ?? 0,
			failureCount: job.triggerRuntime?.failureCount ?? 0,
			baselineObserved: job.triggerRuntime?.baselineObserved ?? false,
			consecutiveMatches: job.triggerRuntime?.consecutiveMatches ?? 0,
			...job.triggerRuntime,
			cause: "monitor_timeout",
			satisfiedAt: now,
		};
		this.touch(job, now);
		return true;
	}

	async claimReady(
		wakeId: string,
		workerId: string,
		leaseMs: number,
		now = new Date().toISOString(),
	): Promise<ClaimedWake | null> {
		const job = this.jobs.get(wakeId);
		if (!job || !isDueForRun(job, now)) return null;
		const leaseToken = (job.lease?.token ?? job.leaseGeneration ?? 0) + 1;
		job.status = "running";
		job.runAttempt += 1;
		job.leaseGeneration = leaseToken;
		job.lease = {
			owner: workerId,
			token: leaseToken,
			expiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString(),
		};
		this.touch(job, now);
		await this.journal?.append({
			kind: "dispatching",
			wakeId: job.id,
			data: { runAttempt: job.runAttempt } as never,
			at: now,
		});
		return { job: clone(job), leaseToken };
	}

	private hasLease(job: WakeJob, leaseToken: number, now: string): boolean {
		return (
			job.status === "running" &&
			job.lease?.token === leaseToken &&
			new Date(job.lease.expiresAt).getTime() > new Date(now).getTime()
		);
	}

	private hasActiveLease(job: WakeJob, leaseToken: number, now: string): boolean {
		return (
			(job.status === "running" || job.status === "cancel_requested") &&
			job.lease?.token === leaseToken &&
			new Date(job.lease.expiresAt).getTime() > new Date(now).getTime()
		);
	}

	async heartbeat(
		wakeId: string,
		leaseToken: number,
		leaseMs: number,
		now = new Date().toISOString(),
	): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || !this.hasLease(job, leaseToken, now)) return false;
		job.lease!.expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
		this.touch(job, now);
		return true;
	}

	async completeRun(wakeId: string, leaseToken: number, now = new Date().toISOString()): Promise<boolean> {
		const job = this.jobs.get(wakeId);
		if (!job || !this.hasActiveLease(job, leaseToken, now)) return false;
		job.status = job.status === "cancel_requested" ? "cancelled" : "completed";
		job.lease = undefined;
		job.completedAt = now;
		this.touch(job, now);
		await this.journal?.append({
			kind: job.status === "cancelled" ? "cancelled" : "completed",
			wakeId: job.id,
			at: now,
		});
		return true;
	}

	private finishRun(
		wakeId: string,
		leaseToken: number,
		status: WakeStatus,
		failure: WakeFailure | undefined,
		nextAttemptAt: string | undefined,
		now: string,
	): boolean {
		const job = this.jobs.get(wakeId);
		if (!job || !this.hasActiveLease(job, leaseToken, now)) return false;
		job.status = job.status === "cancel_requested" ? "cancelled" : status;
		job.lastError = failure ? toError(failure, now) : undefined;
		job.nextRunAttemptAt = nextAttemptAt;
		job.lease = undefined;
		this.touch(job, now);
		void this.journal?.append({
			kind: status === "run_retry_wait" ? "retryable" : status === "blocked" ? "blocked" : "rejected",
			wakeId: job.id,
			error: failure as never,
			at: now,
		});
		return true;
	}

	retryRunLater(
		wakeId: string,
		leaseToken: number,
		failure: WakeFailure,
		nextAttemptAt: string,
		now?: string,
	): Promise<boolean> {
		return Promise.resolve(this.finishRun(wakeId, leaseToken, "run_retry_wait", failure, nextAttemptAt, nowIso(now)));
	}

	block(wakeId: string, leaseToken: number, failure: WakeFailure, now?: string): Promise<boolean> {
		return Promise.resolve(this.finishRun(wakeId, leaseToken, "blocked", failure, undefined, nowIso(now)));
	}

	moveToDeadLetter(wakeId: string, leaseToken: number, failure: WakeFailure, now?: string): Promise<boolean> {
		return Promise.resolve(this.finishRun(wakeId, leaseToken, "dead_letter", failure, undefined, nowIso(now)));
	}

	async reapExpiredLeases(now = new Date().toISOString()): Promise<number> {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (
				(job.status !== "running" && job.status !== "cancel_requested") ||
				!job.lease ||
				new Date(job.lease.expiresAt).getTime() > new Date(now).getTime()
			)
				continue;
			const cancelRequested = job.status === "cancel_requested";
			job.status = cancelRequested ? "cancelled" : job.runAttempt >= job.maxRunAttempts ? "dead_letter" : "ready";
			job.lease = undefined;
			job.nextRunAttemptAt = job.status === "ready" ? now : undefined;
			job.lastError = {
				phase: "agent_run",
				code: "WAKE_LEASE_EXPIRED",
				message: "Worker lease expired before the run was finalized",
				retriable: job.status === "ready",
				at: now,
			};
			this.touch(job, now);
			count++;
		}
		return count;
	}
}
