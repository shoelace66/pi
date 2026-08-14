import type { WakeJob, WakeSource } from "./types.ts";

export type WakePromptInput = {
	job?: Pick<WakeJob, "id" | "reason" | "objective" | "checkFirst">;
	source: WakeSource;
	evidence?: unknown;
	message?: string;
};

function sourceLabel(source: WakeSource): string {
	switch (source.kind) {
		case "timer":
			return `timer ${source.wakeId}`;
		case "monitor":
			return `monitor ${source.adapter} ${source.wakeId}`;
		case "user_cancel":
			return `user cancellation ${source.wakeId}`;
		case "agent":
			return `agent letter (self-reported / unverified) ${source.claimedFrom.agentId}`;
	}
}

/**
 * Compose the only wake message format used by timers, monitors, user
 * cancellation, and future agent-to-agent delivery. The body is JSON so text
 * inside it cannot forge the routing headers.
 */
export function composeWakePrompt(input: WakePromptInput): string {
	const source =
		input.source.kind === "agent"
			? {
					kind: input.source.kind,
					verification: input.source.verification,
					claimedFrom: input.source.claimedFrom,
				}
			: { kind: input.source.kind, wakeId: input.source.wakeId };
	const body = {
		source,
		label: sourceLabel(input.source),
		wakeId: input.job?.id ?? ("wakeId" in input.source ? input.source.wakeId : undefined),
		reason: input.job?.reason,
		objective: input.job?.objective,
		checkFirst: input.job?.checkFirst ?? [],
		evidence: input.evidence,
		message:
			input.message ??
			(input.source.kind === "agent"
				? input.source.message
				: input.source.kind === "user_cancel"
					? `用户取消了该定时/监测任务${input.source.note ? `：${input.source.note}` : ""}`
					: undefined),
	};
	return `<outer_loop_wake>\n${JSON.stringify(body)}\n</outer_loop_wake>`;
}

export function composeUserCancellationPrompt(wakeId: string, note?: string): string {
	return `<outer_loop_user_cancelled>\n${JSON.stringify({
		wakeId,
		message: `用户取消了该定时/监测任务${note ? `：${note}` : ""}`,
		note,
	})}\n</outer_loop_user_cancelled>`;
}
