import type { AgentSession } from "../agent-session.ts";
import { composeWakePrompt } from "./prompt-composer.ts";
import type { WakeJob, WakeSessionReference, WakeSource } from "./types.ts";
import type { WakeJournal } from "./wake-journal.ts";

export type AgentTargetRef = {
	kind: "pi_session";
	session: WakeSessionReference;
};

export type AgentWakeRequest = {
	requestId: string;
	target: AgentTargetRef;
	source: WakeSource;
	job?: Pick<WakeJob, "id" | "reason" | "objective" | "checkFirst">;
	evidence?: unknown;
	message?: string;
};

export type AgentWakeStatus = "completed" | "retryable" | "blocked" | "cancelled" | "rejected";

export type AgentWakeResult = {
	requestId: string;
	status: AgentWakeStatus;
	message?: string;
	error?: { code: string; message: string; retriable: boolean };
};

export type ResolvedAgentTarget = {
	session: AgentSession;
	release?: () => Promise<void> | void;
};

export interface AgentTargetResolver {
	resolve(target: AgentTargetRef): Promise<ResolvedAgentTarget>;
}

export type AgentWakeServiceOptions = {
	resolver: AgentTargetResolver;
	/** Per-target serialization. Waiting never uses steer/follow-up. */
	queueKey?: (target: AgentTargetRef) => string;
	journal?: WakeJournal;
};

function classify(error: unknown): NonNullable<AgentWakeResult["error"]> {
	const message = error instanceof Error ? error.message : String(error);
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code)
			: "AGENT_WAKE_FAILED";
	const blocked = /auth|permission|model|api key|not found|persisted/i.test(message);
	return { code, message, retriable: !blocked };
}

function waitForSettled(session: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		const finish = () => {
			unsubscribe?.();
			resolve();
		};
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") {
				finish();
			}
		});
		if (session.isIdle) finish();
	});
}

/**
 * Unified wake entry point. Timer, monitor, user-cancel and future agent
 * sources all use this service; target restoration and prompt composition are
 * intentionally outside the outer-loop state machine.
 */
export class AgentWakeService {
	private readonly resolver: AgentTargetResolver;
	private readonly queueKey: (target: AgentTargetRef) => string;
	private readonly tails = new Map<string, Promise<void>>();
	private readonly requests = new Map<string, Promise<AgentWakeResult>>();
	private readonly journal?: WakeJournal;

	constructor(options: AgentWakeServiceOptions) {
		this.resolver = options.resolver;
		this.queueKey = options.queueKey ?? ((target) => target.session.file);
		this.journal = options.journal;
	}

	wake(request: AgentWakeRequest): Promise<AgentWakeResult> {
		const existing = this.requests.get(request.requestId);
		if (existing) return existing;
		const key = this.queueKey(request.target);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const task = previous.then(() => this.dispatch(request));
		// Keep a simple tail promise without exposing dispatch failures to later jobs.
		const tail = task.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		this.requests.set(request.requestId, task);
		return task;
	}

	private async dispatch(request: AgentWakeRequest): Promise<AgentWakeResult> {
		let resolved: ResolvedAgentTarget | undefined;
		let content: string | undefined;
		try {
			content = composeWakePrompt({
				job: request.job,
				source: request.source,
				evidence: request.evidence,
				message: request.message,
			});
			await this.journal?.append({
				kind: "dispatching",
				wakeId: request.job?.id,
				requestId: request.requestId,
				source: request.source,
				target: { kind: request.target.kind, session: request.target.session } as never,
				content,
			});
			resolved = await this.resolver.resolve(request.target);
			const session = resolved.session;
			await waitForSettled(session);
			await session.sendCustomMessage(
				{
					customType: "outer_loop_wake",
					content: [{ type: "text", text: content }],
					display: false,
					details: { requestId: request.requestId },
				},
				{ triggerTurn: true, preflight: true },
			);
			const completed = { requestId: request.requestId, status: "completed" as const };
			await this.journal?.append({
				kind: "completed",
				wakeId: request.job?.id,
				requestId: request.requestId,
				source: request.source,
				target: { kind: request.target.kind, session: request.target.session } as never,
				content,
			});
			return completed;
		} catch (error) {
			const classified = classify(error);
			const result: AgentWakeResult = {
				requestId: request.requestId,
				status: classified.retriable ? "retryable" : "blocked",
				error: classified,
			};
			await this.journal?.append({
				kind: result.status,
				wakeId: request.job?.id,
				requestId: request.requestId,
				source: request.source,
				target: { kind: request.target.kind, session: request.target.session } as never,
				content,
				error: classified as never,
			});
			return result;
		} finally {
			await resolved?.release?.();
		}
	}
}
