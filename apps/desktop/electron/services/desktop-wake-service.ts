import { randomUUID } from "node:crypto";
import type { WakeJob, WakeStore } from "@earendil-works/pi-coding-agent";
import type { DeferredMessageView, WakeJobView } from "../../shared/view-models.ts";

function toWakeView(job: WakeJob, pendingInboxCount: number): WakeJobView {
	return {
		id: job.id,
		sessionId: job.session.id,
		status: job.status,
		kind: job.trigger.type,
		reason: job.reason,
		objective: job.objective,
		checkFirst: job.checkFirst,
		triggerLabel: job.trigger.type === "time" ? `At ${job.trigger.dueAt}` : `Monitor ${job.trigger.adapter}`,
		dueAt: job.trigger.type === "time" ? job.trigger.dueAt : undefined,
		nextCheckAt: job.triggerRuntime?.nextCheckAt,
		cause: job.triggerRuntime?.cause,
		observation: job.triggerRuntime?.evidence
			? {
					observedAt: job.triggerRuntime.evidence.observedAt,
					summary: job.triggerRuntime.evidence.summary,
					fields: job.triggerRuntime.evidence.fields,
				}
			: undefined,
		pendingInboxCount,
		runAttempt: job.runAttempt,
		maxRunAttempts: job.maxRunAttempts,
		error: job.lastError
			? { code: job.lastError.code, message: job.lastError.message, retriable: job.lastError.retriable }
			: undefined,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
}

export class DesktopWakeService {
	private readonly store: WakeStore;
	private readonly inbox = new Map<string, DeferredMessageView[]>();

	constructor(store: WakeStore) {
		this.store = store;
	}

	private pendingCount(wakeId: string): number {
		return (this.inbox.get(wakeId) ?? []).filter(
			(message) => message.status === "pending" || message.status === "delivering",
		).length;
	}

	async list(sessionId: string, includeTerminal = false): Promise<WakeJobView[]> {
		const jobs = await this.store.listBySession(
			sessionId,
			includeTerminal ? undefined : ["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"],
		);
		return jobs.map((job) => toWakeView(job, this.pendingCount(job.id)));
	}

	getInbox(wakeId: string): DeferredMessageView[] {
		return [...(this.inbox.get(wakeId) ?? [])];
	}

	async queueInput(input: {
		sessionId: string;
		wakeId?: string;
		clientMessageId: string;
		content: string;
	}): Promise<DeferredMessageView> {
		const jobs = await this.store.listBySession(input.sessionId);
		const job = input.wakeId ? jobs.find((candidate) => candidate.id === input.wakeId) : jobs[0];
		if (!job) throw new Error("No active automation is available for this chat");
		const message: DeferredMessageView = {
			id: randomUUID(),
			clientMessageId: input.clientMessageId,
			wakeId: job.id,
			content: input.content,
			createdAt: new Date().toISOString(),
			status: "pending",
		};
		this.inbox.set(job.id, [...(this.inbox.get(job.id) ?? []), message]);
		return message;
	}

	markDelivering(wakeId: string): void {
		this.updateMessages(wakeId, "pending", "delivering");
	}

	markDelivered(wakeId: string): void {
		this.updateMessages(wakeId, "delivering", "delivered");
	}

	private updateMessages(
		wakeId: string,
		from: DeferredMessageView["status"],
		to: DeferredMessageView["status"],
	): void {
		const messages = this.inbox.get(wakeId);
		if (!messages) return;
		this.inbox.set(
			wakeId,
			messages.map((message) => (message.status === from ? { ...message, status: to } : message)),
		);
	}

	async cancel(sessionId: string, wakeId: string): Promise<WakeJobView> {
		const job = await this.store.cancelOwned(wakeId, sessionId);
		const messages = this.inbox.get(wakeId);
		if (messages) {
			this.inbox.set(
				wakeId,
				messages.map((message) =>
					message.status === "pending" || message.status === "delivering"
						? { ...message, status: "cancelled" }
						: message,
				),
			);
		}
		return toWakeView(job, this.pendingCount(job.id));
	}
}
