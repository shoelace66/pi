import type { InlineExtension } from "../extensions/types.ts";
import type { WakeJob, WakeStore } from "./types.ts";

const TERMINAL = new Set(["completed", "cancelled", "expired", "dead_letter"]);

function dueText(job: WakeJob): string {
	if (job.trigger.type === "time") return `due ${job.trigger.dueAt}`;
	if (job.trigger.intent?.kind === "file") return `next ${job.triggerRuntime?.nextCheckAt ?? "poll"}`;
	return `next ${job.triggerRuntime?.nextCheckAt ?? "poll"}`;
}

function triggerText(job: WakeJob): string {
	if (job.trigger.type === "time") return "timer";
	if (job.trigger.intent?.kind === "file") return `file.${job.trigger.intent.event}`;
	if (job.trigger.intent?.kind === "process") return "process.exited";
	return `monitor.${job.trigger.adapter}`;
}

export function formatOuterLoopClock(jobs: WakeJob[], generatedAt = new Date().toISOString()): string {
	const active = jobs.filter((job) => !TERMINAL.has(job.status));
	if (active.length === 0) return "";
	const shown = active.slice(0, 10);
	const lines = shown.map((job) => `clock: ${job.id} | ${triggerText(job)} | ${dueText(job)} | ${job.reason}`);
	if (active.length > shown.length)
		lines.push(`clock: ... and ${active.length - shown.length} more; call outer_loop.list`);
	return `<outer_loop_clock generatedAt="${generatedAt}">\n${lines.join("\n")}\nYou may cancel an obsolete item with outer_loop.cancel(wakeId).\n</outer_loop_clock>`;
}

/** Hidden inline extension appended after all user/native extensions. */
export function createOuterLoopClockExtension(store: WakeStore, getSessionId: () => string): InlineExtension {
	return {
		name: "outer-loop-clock",
		hidden: true,
		factory: (pi) => {
			pi.on("before_agent_start", async (event) => {
				try {
					const jobs = await store.listBySession(getSessionId());
					const clock = formatOuterLoopClock(jobs);
					const notices = (await store.listPendingUserNotifications?.(getSessionId())) ?? [];
					const noticeText = notices.length
						? `\n${notices.map((item) => `用户取消了该定时/监测任务: ${item.wakeId}${item.note ? ` (${item.note})` : ""}`).join("\n")}`
						: "";
					if (!clock && !noticeText) return;
					if (notices.length)
						await store.acknowledgeUserNotifications?.(
							getSessionId(),
							notices.map((item) => item.wakeId),
						);
					return { systemPrompt: `${event.systemPrompt}\n\n${clock}${noticeText}` };
				} catch {
					return {
						systemPrompt: `${event.systemPrompt}\n\n<outer_loop_clock>\nclock unavailable\n</outer_loop_clock>`,
					};
				}
			});
		},
	};
}
