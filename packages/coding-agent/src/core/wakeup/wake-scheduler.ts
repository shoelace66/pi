import { evaluateMonitorCondition } from "./condition-evaluator.ts";
import type { MonitorRegistry } from "./monitor-registry.ts";
import type { MonitorObservation, WakeJob, WakeStore } from "./types.ts";
import type { WakeRunner } from "./wake-runner.ts";

export type WakeSchedulerOptions = {
	store: WakeStore;
	monitorRegistry: MonitorRegistry;
	runner: WakeRunner;
	checkIntervalMs?: number;
	maxBatchSize?: number;
	onChanged?: () => Promise<void> | void;
};

function nextCheckAt(job: WakeJob, now: number): string | undefined {
	if (job.trigger.type !== "monitor" || job.trigger.delivery.mode !== "poll") return undefined;
	// Polling is a user-visible contract. Do not add random jitter here: a
	// jittered check can move past a monitor timeout and make an otherwise
	// valid transition appear to have been missed.
	return new Date(now + job.trigger.delivery.intervalMs).toISOString();
}

export class WakeScheduler {
	private readonly store: WakeStore;
	private readonly monitorRegistry: MonitorRegistry;
	private readonly runner: WakeRunner;
	private readonly checkIntervalMs: number;
	private readonly maxBatchSize: number;
	private readonly onChanged?: () => Promise<void> | void;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = true;
	private tickPromise?: Promise<void>;
	private readonly monitorChecks = new Map<string, Promise<boolean>>();

	constructor(options: WakeSchedulerOptions) {
		this.store = options.store;
		this.monitorRegistry = options.monitorRegistry;
		this.runner = options.runner;
		this.checkIntervalMs = options.checkIntervalMs ?? 15_000;
		this.maxBatchSize = options.maxBatchSize ?? 50;
		this.onChanged = options.onChanged;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		void this.scheduleNextTick();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.tickPromise;
		await Promise.allSettled(this.monitorChecks.values());
	}

	async tick(now = new Date()): Promise<void> {
		if (this.tickPromise) return this.tickPromise;
		this.tickPromise = this.runTick(now).finally(() => {
			this.tickPromise = undefined;
		});
		return this.tickPromise;
	}

	/** Ensure a fresh scheduler pass runs after any currently active pass. */
	async requestTick(): Promise<void> {
		if (this.tickPromise) await this.tickPromise;
		await this.tick();
	}

	/** Observe one armed polling monitor immediately after it is created. */
	async sampleNow(job: WakeJob, now = new Date()): Promise<WakeJob | undefined> {
		if (job.trigger.type !== "monitor" || job.trigger.delivery.mode !== "poll") return undefined;
		await this.observeMonitor(job, now);
		await this.onChanged?.();
		return (await this.store.listBySession(job.session.id)).find((candidate) => candidate.id === job.id);
	}

	/** Handle a previously verified push event. */
	async handlePush(subscriptionId: string, observation: MonitorObservation, now = new Date()): Promise<number> {
		const jobs = await this.store.listArmedMonitorJobsBySubscription(subscriptionId, this.maxBatchSize);
		let changed = 0;
		for (const job of jobs) {
			if (job.trigger.type !== "monitor") continue;
			if (
				job.triggerRuntime?.lastObservation?.eventId &&
				job.triggerRuntime.lastObservation.eventId === observation.eventId
			)
				continue;
			if (new Date(job.trigger.timeout.at).getTime() <= now.getTime()) {
				if (job.trigger.timeout.action === "expire") {
					if (await this.store.expire(job.id, now.toISOString())) changed++;
				} else if (
					await this.store.markReady(
						job.id,
						{ cause: "monitor_timeout", satisfiedAt: now.toISOString() },
						now.toISOString(),
					)
				)
					changed++;
				continue;
			}
			const evaluation = evaluateMonitorCondition(job, observation);
			if (await this.store.recordMonitorObservation(job.id, observation, evaluation, undefined, now.toISOString()))
				changed++;
		}
		if (changed) await this.onChanged?.();
		return changed;
	}

	private async scheduleNextTick(): Promise<void> {
		if (this.stopped) return;
		await this.tick();
		if (this.stopped) return;
		this.timer = setTimeout(() => void this.scheduleNextTick(), this.checkIntervalMs);
	}

	private async runTick(nowDate: Date): Promise<void> {
		const now = nowDate.toISOString();
		let changed = false;

		// Time due jobs are cheap and deterministic. markReady is CAS-protected,
		// so a second scheduler process cannot make the same job ready twice.
		const timeJobs = await this.store.listDueTimeJobs(now, this.maxBatchSize);
		for (const job of timeJobs) {
			changed = (await this.store.markReady(job.id, { cause: "time_due", satisfiedAt: now }, now)) || changed;
		}

		const monitorJobs = await this.store.listDueMonitorJobs(now, this.maxBatchSize);
		for (const job of monitorJobs) {
			changed = (await this.observeMonitor(job, nowDate)) || changed;
		}

		const readyJobs = await this.store.listDueRunJobs(now, this.maxBatchSize);
		for (const job of readyJobs) {
			changed = (await this.runner.run(job.id)) || changed;
		}
		changed = (await this.store.reapExpiredLeases(now)) > 0 || changed;
		if (changed) await this.onChanged?.();
	}

	private observeMonitor(job: WakeJob, nowDate: Date): Promise<boolean> {
		const existing = this.monitorChecks.get(job.id);
		if (existing) return existing;
		const check = this.performMonitorObservation(job, nowDate).finally(() => {
			if (this.monitorChecks.get(job.id) === check) this.monitorChecks.delete(job.id);
		});
		this.monitorChecks.set(job.id, check);
		return check;
	}

	private async performMonitorObservation(job: WakeJob, nowDate: Date): Promise<boolean> {
		if (job.trigger.type !== "monitor" || job.trigger.delivery.mode !== "poll") return false;
		const now = nowDate.toISOString();
		const timeoutAt = new Date(job.trigger.timeout.at).getTime();
		const adapter = this.monitorRegistry.get(job.trigger.adapter);
		if (!adapter) {
			const monitorError = {
				phase: "monitor" as const,
				code: "MONITOR_ADAPTER_NOT_FOUND",
				message: `Monitor adapter not found: ${job.trigger.adapter}`,
				retriable: false,
				at: now,
			};
			const recorded = await this.store.recordMonitorFailure(
				job.id,
				monitorError,
				nextCheckAt(job, nowDate.getTime()),
				now,
			);
			if (timeoutAt <= nowDate.getTime()) {
				if (job.trigger.timeout.action === "expire") return (await this.store.expire(job.id, now)) || recorded;
				return (
					(await this.store.markReady(
						job.id,
						{ cause: "monitor_timeout", monitorError, satisfiedAt: now },
						now,
					)) || recorded
				);
			}
			return recorded;
		}
		try {
			const observation = await adapter.observe(job.trigger.source);
			const evaluation = evaluateMonitorCondition(job, observation);
			const observed = await this.store.recordMonitorObservation(
				job.id,
				observation,
				evaluation,
				nextCheckAt(job, nowDate.getTime()),
				now,
			);
			if (timeoutAt <= nowDate.getTime() && !evaluation.matched) {
				if (job.trigger.timeout.action === "expire") return (await this.store.expire(job.id, now)) || observed;
				return (
					(await this.store.markReady(job.id, { cause: "monitor_timeout", satisfiedAt: now }, now)) || observed
				);
			}
			return observed;
		} catch (error) {
			const monitorError = {
				phase: "monitor" as const,
				code:
					error && typeof error === "object" && "code" in error
						? String((error as { code?: unknown }).code)
						: "MONITOR_OBSERVE_FAILED",
				message: error instanceof Error ? error.message : String(error),
				retriable: false,
				at: now,
			};
			const recorded = await this.store.recordMonitorFailure(
				job.id,
				monitorError,
				nextCheckAt(job, nowDate.getTime()),
				now,
			);
			if (timeoutAt <= nowDate.getTime()) {
				if (job.trigger.timeout.action === "expire") return (await this.store.expire(job.id, now)) || recorded;
				return (
					(await this.store.markReady(
						job.id,
						{ cause: "monitor_timeout", monitorError, satisfiedAt: now },
						now,
					)) || recorded
				);
			}
			return recorded;
		}
	}
}
