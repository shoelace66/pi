import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { SessionManager } from "../session-manager.ts";
import type { WakeRegistration } from "../wake/types.ts";
import type { ClaimedWake, JsonValue, WakeFailure, WakeJob, WakeStore } from "./types.ts";

export type WakeRunnerOptions = {
	store: WakeStore;
	workerId: string;
	leaseMs?: number;
	allowedSessionRoot?: string;
	resolveRegistration: (job: WakeJob) => Promise<WakeRegistration>;
	onRunStarted?: (job: WakeJob) => Promise<void> | void;
	onRunFinished?: (job: WakeJob) => Promise<void> | void;
};

function classifyError(error: unknown): WakeFailure {
	const message = error instanceof Error ? error.message : String(error);
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code)
			: "WAKE_RUN_FAILED";
	const requiresUser = Boolean(
		(error &&
			typeof error === "object" &&
			"requiresUser" in error &&
			Boolean((error as { requiresUser?: unknown }).requiresUser)) ||
			/auth|credential|permission|approval|api key|model/i.test(message),
	);
	const retriable =
		error && typeof error === "object" && "retriable" in error
			? Boolean((error as { retriable?: unknown }).retriable)
			: !requiresUser;
	return {
		phase: /session|header|path/i.test(message) ? "restore" : "agent_run",
		code,
		message,
		retriable,
		requiresUser,
	};
}

async function validateSessionFile(claimed: ClaimedWake, allowedSessionRoot?: string): Promise<string> {
	const file = resolve(claimed.job.session.file);
	if (!isAbsolute(claimed.job.session.file)) throw new Error("Session file must be absolute");
	if (allowedSessionRoot) {
		const root = resolve(allowedSessionRoot);
		if (!file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`))
			throw new Error("Session file is outside the allowed session root");
	}
	await access(file);
	const sessionManager = SessionManager.open(file, undefined, claimed.job.session.cwd);
	const header = sessionManager.getHeader();
	if (!header || header.id !== claimed.job.session.id) throw new Error("Session header ID does not match Wake Job");
	if (resolve(header.cwd) !== resolve(claimed.job.session.cwd)) throw new Error("Session cwd does not match Wake Job");
	return file;
}

export class WakeRunner {
	private readonly store: WakeStore;
	private readonly workerId: string;
	private readonly leaseMs: number;
	private readonly allowedSessionRoot?: string;
	private readonly resolveRegistration: (job: WakeJob) => Promise<WakeRegistration>;
	private readonly onRunStarted?: (job: WakeJob) => Promise<void> | void;
	private readonly onRunFinished?: (job: WakeJob) => Promise<void> | void;

	constructor(options: WakeRunnerOptions) {
		this.store = options.store;
		this.workerId = options.workerId;
		this.leaseMs = options.leaseMs ?? 5 * 60_000;
		this.allowedSessionRoot = options.allowedSessionRoot;
		this.resolveRegistration = options.resolveRegistration;
		this.onRunStarted = options.onRunStarted;
		this.onRunFinished = options.onRunFinished;
	}

	async run(wakeId: string): Promise<boolean> {
		const claimed = await this.store.claimReady(wakeId, this.workerId, this.leaseMs);
		if (!claimed) return false;
		const { job, leaseToken } = claimed;
		await this.onRunStarted?.(job);
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		try {
			await validateSessionFile(claimed, this.allowedSessionRoot);
			heartbeatTimer = setInterval(
				() => {
					void this.store.heartbeat(job.id, leaseToken, this.leaseMs).catch(() => undefined);
				},
				Math.max(1_000, Math.floor(this.leaseMs / 2)),
			);
			const registration = await this.resolveRegistration(job);
			const evidence = job.triggerRuntime?.evidence;
			const wakeEvent =
				job.trigger.type === "monitor" && job.trigger.adapter === "custom_monitor"
					? evidence?.fields.wakeEvent
					: undefined;
			const customWake =
				wakeEvent && typeof wakeEvent === "object" && !Array.isArray(wakeEvent)
					? (wakeEvent as Record<string, JsonValue>)
					: undefined;
			const customEventId =
				typeof customWake?.eventId === "string" && customWake.eventId ? customWake.eventId : undefined;
			const customMessage =
				typeof customWake?.message === "string" && customWake.message ? customWake.message : undefined;
			await registration.emit({
				eventId: customEventId ? `${job.id}:${customEventId}` : `${job.id}:${job.runAttempt}`,
				message:
					customMessage ??
					(job.trigger.type === "time"
						? `Outer-loop timer ${job.id} is due.`
						: `Outer-loop monitor ${job.id} is ready (${job.triggerRuntime?.cause ?? "condition"}).`),
				data: {
					wakeId: job.id,
					trigger: job.trigger,
					cause: job.triggerRuntime?.cause ?? null,
					evidence: job.triggerRuntime?.evidence ?? null,
					monitorError: job.triggerRuntime?.monitorError ?? null,
					checkFirst: job.checkFirst,
					selfReported: Boolean(customWake),
					customData: customWake?.data ?? null,
				},
			});
			const result = await registration.outcome;
			if (result.status !== "completed") {
				throw Object.assign(new Error(result.error?.message ?? `Wake ${result.status}`), {
					code: result.error?.code ?? "AGENT_WAKE_FAILED",
					retriable: result.status === "retryable",
					requiresUser: result.status === "blocked",
				});
			}
			return this.store.completeRun(job.id, leaseToken);
		} catch (error) {
			const failure = classifyError(error);
			const nextAttempt = new Date(
				Date.now() + Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, job.runAttempt - 1)),
			).toISOString();
			if (failure.requiresUser) {
				await this.store.block(job.id, leaseToken, failure).catch(() => false);
			} else if (failure.retriable && job.runAttempt < job.maxRunAttempts) {
				await this.store.retryRunLater(job.id, leaseToken, failure, nextAttempt).catch(() => false);
			} else {
				await this.store.moveToDeadLetter(job.id, leaseToken, failure).catch(() => false);
			}
			return false;
		} finally {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			const current = (await this.store.listBySession(job.session.id)).find((item) => item.id === job.id);
			await this.onRunFinished?.(current ?? job);
		}
	}
}
