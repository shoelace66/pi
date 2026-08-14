import { isAbsolute, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MonitorRegistry } from "./monitor-registry.ts";
import type { FileWakeEvent, JsonValue, WakeJob, WakeObjective, WakeStatus, WakeStore } from "./types.ts";
import { DEFAULT_WAKE_POLICY, normalizeCreateWakeInput, WakePolicyError } from "./wake-policy.ts";

const DurationStringSchema = Type.String({
	pattern: "^[0-9]{2,}:[0-5][0-9]:[0-5][0-9]$",
	description: "Duration in HH:MM:SS format, for example 00:05:00.",
});

function durationSchema(minimum: number, maximum: number, description: string) {
	return Type.Union([Type.Integer({ minimum, maximum, description }), DurationStringSchema]);
}

const IntentDurationSchema = durationSchema(
	DEFAULT_WAKE_POLICY.minDelayMs,
	DEFAULT_WAKE_POLICY.maxDelayMs,
	"Duration in milliseconds, or an HH:MM:SS duration. Numeric values are milliseconds.",
);
const PollIntervalSchema = durationSchema(
	DEFAULT_WAKE_POLICY.minPollIntervalMs,
	DEFAULT_WAKE_POLICY.maxPollIntervalMs,
	"Polling interval in milliseconds, or an HH:MM:SS duration. Numeric values are milliseconds.",
);

const TimeoutSchema = Type.Object({
	kind: Type.Union([Type.Literal("after"), Type.Literal("at")]),
	value: Type.String({ description: "HH:MM:SS duration or timezone-aware ISO 8601 timestamp." }),
	onTimeout: Type.Union([Type.Literal("wake"), Type.Literal("expire")]),
});

const IntentObjectiveSchema = Type.Object({
	reason: Type.String({ description: "Why progress depends on a future event." }),
	objective: Type.String({ description: "What to re-check and continue after waking." }),
	checkFirst: Type.Optional(Type.Array(Type.String({ description: "State to re-check before side effects." }))),
});

/** Stable model-facing contract. Raw field/operator/activation DSL is internal only. */
const OuterLoopSchema = Type.Union(
	[
		Type.Intersect([
			Type.Object({ action: Type.Literal("wait_time") }),
			IntentObjectiveSchema,
			Type.Union([
				Type.Object({ after: IntentDurationSchema }),
				Type.Object({ at: Type.String({ description: "Timezone-aware ISO 8601 timestamp." }) }),
			]),
		]),
		Type.Intersect([
			Type.Object({ action: Type.Literal("wait_file") }),
			IntentObjectiveSchema,
			Type.Object({
				path: Type.String(),
				event: Type.Union([
					Type.Literal("exists"),
					Type.Literal("missing"),
					Type.Literal("modified"),
					Type.Literal("content_changed"),
				]),
				timeout: TimeoutSchema,
				pollInterval: Type.Optional(PollIntervalSchema),
			}),
		]),
		Type.Intersect([
			Type.Object({ action: Type.Literal("wait_process") }),
			IntentObjectiveSchema,
			Type.Object({
				pid: Type.Integer({ minimum: 1 }),
				event: Type.Literal("exited"),
				timeout: TimeoutSchema,
				pollInterval: Type.Optional(PollIntervalSchema),
			}),
		]),
		Type.Object({ action: Type.Literal("list"), includeTerminal: Type.Optional(Type.Boolean()) }),
		Type.Object({ action: Type.Literal("cancel"), wakeId: Type.String() }),
	],
	{ type: "object" },
);

export type OuterLoopInput = Static<typeof OuterLoopSchema>;
type ExecuteContext = Parameters<NonNullable<ToolDefinition["execute"]>>[4];

export type OuterLoopToolContext = {
	store: WakeStore;
	monitorRegistry: MonitorRegistry;
	allowedRoot: string;
	sampleMonitor?: (job: WakeJob) => Promise<WakeJob | undefined>;
	requestRun?: () => void;
	onChanged?: () => void;
};

function textResult(
	text: string,
	details: unknown = {},
): { content: [{ type: "text"; text: string }]; details: unknown } {
	return { content: [{ type: "text", text }], details };
}

function sessionReference(ctx: ExecuteContext) {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) throw new WakePolicyError("WAKE_SESSION_NOT_PERSISTED", "outer_loop requires a persisted session");
	return { id: ctx.sessionManager.getSessionId(), file, cwd: ctx.cwd };
}

function isWithin(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveProjectPath(value: string, ctx: ExecuteContext, allowedRoot: string): string {
	const candidate = resolve(ctx.cwd, value);
	const root = resolve(allowedRoot);
	if (!isWithin(candidate, root)) {
		throw new WakePolicyError(
			"OUTER_LOOP_PATH_OUTSIDE_PROJECT",
			"outer_loop file path must stay inside the current project directory",
		);
	}
	return candidate;
}

function objective(input: { reason: string; objective: string; checkFirst?: string[] }): WakeObjective {
	return { reason: input.reason, objective: input.objective, checkFirst: input.checkFirst ?? [] };
}

function listStatuses(includeTerminal: boolean | undefined) {
	return includeTerminal
		? undefined
		: (["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"] as WakeStatus[]);
}

function formatJob(job: WakeJob): string {
	const runtime = job.triggerRuntime;
	const schedule =
		job.trigger.type === "time"
			? `due=${job.trigger.dueAt}`
			: `timeout=${job.trigger.timeout.at} onTimeout=${job.trigger.timeout.action}`;
	const parts = [
		`${job.id} ${job.status} ${job.trigger.type} ${schedule}`,
		`objective=${job.objective}`,
		`reason=${job.reason}`,
	];
	if (runtime?.lastObservation)
		parts.push(`last=${runtime.lastObservation.observedAt} ${runtime.lastObservation.summary}`);
	if (runtime?.nextCheckAt) parts.push(`next=${runtime.nextCheckAt}`);
	if (runtime) parts.push(`checks=${runtime.checkCount}`);
	if (runtime?.monitorError) parts.push(`error=${runtime.monitorError.code}: ${runtime.monitorError.message}`);
	else if (job.lastError) parts.push(`error=${job.lastError.code}: ${job.lastError.message}`);
	return parts.join(" | ");
}

const DURATION_PATTERN = /^(\d{2,}):([0-5]\d):([0-5]\d)$/;

function parseDurationMs(value: unknown, field: string): number {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new WakePolicyError(
				"WAKE_INVALID_DURATION",
				`${field} must be a non-negative integer number of milliseconds.`,
			);
		}
		return value;
	}
	if (typeof value !== "string") {
		throw new WakePolicyError("WAKE_INVALID_DURATION", `${field} must be milliseconds or an HH:MM:SS duration.`);
	}
	const match = DURATION_PATTERN.exec(value);
	if (!match) {
		throw new WakePolicyError(
			"WAKE_INVALID_DURATION",
			`${field}=${JSON.stringify(value)} must use HH:MM:SS with two or more hour digits, for example 00:05:00.`,
		);
	}
	const milliseconds = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000;
	if (!Number.isSafeInteger(milliseconds))
		throw new WakePolicyError("WAKE_INVALID_DURATION", `${field} is too large.`);
	return milliseconds;
}

function checkedDurationMs(value: unknown, field: string, minimum: number, maximum: number): number {
	const milliseconds = parseDurationMs(value, field);
	if (milliseconds < minimum) {
		throw new WakePolicyError(
			"WAKE_DURATION_TOO_SHORT",
			`${field}=${JSON.stringify(value)} equals ${milliseconds}ms, below the minimum of ${minimum}ms. Numeric values are milliseconds.`,
		);
	}
	if (milliseconds > maximum) {
		throw new WakePolicyError(
			"WAKE_DURATION_TOO_LONG",
			`${field}=${JSON.stringify(value)} equals ${milliseconds}ms, above the maximum of ${maximum}ms.`,
		);
	}
	return milliseconds;
}

function parseDateWithPolicy(value: string, field: string): string {
	if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value))
		throw new WakePolicyError("WAKE_TIMEZONE_REQUIRED", `${field} must include an explicit timezone.`);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()))
		throw new WakePolicyError("WAKE_INVALID_TIME", `${field} is not valid ISO 8601.`);
	return parsed.toISOString();
}

function normalizeIntentTimeout(input: { kind: "after" | "at"; value: string; onTimeout: "wake" | "expire" }): string {
	return input.kind === "after"
		? new Date(
				Date.now() +
					checkedDurationMs(
						input.value,
						"timeout.value",
						DEFAULT_WAKE_POLICY.minDelayMs,
						DEFAULT_WAKE_POLICY.maxMonitorDurationMs,
					),
			).toISOString()
		: parseDateWithPolicy(input.value, "timeout.value");
}

function intentCondition(event: "exists" | "missing" | "modified" | "content_changed" | "exited") {
	if (event === "exists")
		return {
			field: "exists",
			operator: "eq" as const,
			expected: true,
			activation: "level" as const,
			consecutiveMatches: 1,
		};
	if (event === "missing")
		return {
			field: "exists",
			operator: "eq" as const,
			expected: false,
			activation: "level" as const,
			consecutiveMatches: 1,
		};
	if (event === "exited")
		return {
			field: "status",
			operator: "eq" as const,
			expected: "exited",
			activation: "level" as const,
			consecutiveMatches: 1,
		};
	return {
		field: "exists",
		operator: "eq" as const,
		expected: true,
		activation: "level" as const,
		consecutiveMatches: 1,
	};
}

function normalizeDurationArguments(input: Record<string, unknown>): Record<string, unknown> {
	const normalized = { ...input };
	if (input.action === "wait_time" && input.after !== undefined)
		normalized.after = checkedDurationMs(
			input.after,
			"after",
			DEFAULT_WAKE_POLICY.minDelayMs,
			DEFAULT_WAKE_POLICY.maxDelayMs,
		);
	if ((input.action === "wait_file" || input.action === "wait_process") && input.pollInterval !== undefined)
		normalized.pollInterval = checkedDurationMs(
			input.pollInterval,
			"pollInterval",
			DEFAULT_WAKE_POLICY.minPollIntervalMs,
			DEFAULT_WAKE_POLICY.maxPollIntervalMs,
		);
	if (input.action === "wait_file" || input.action === "wait_process") {
		const timeout = input.timeout;
		if (timeout && typeof timeout === "object") {
			const value = { ...(timeout as Record<string, unknown>) };
			if (value.kind === "after") value.value = `${String(value.value)}`;
			normalized.timeout = value;
		}
	}
	return normalized;
}

function prepareOuterLoopArguments(args: unknown): Static<typeof OuterLoopSchema> {
	if (!args || typeof args !== "object") return args as Static<typeof OuterLoopSchema>;
	return normalizeDurationArguments(args as Record<string, unknown>) as Static<typeof OuterLoopSchema>;
}

export function createOuterLoopTool(context: OuterLoopToolContext): ToolDefinition<any> {
	return {
		name: "outer_loop",
		label: "Outer loop",
		description:
			"Wait for a time, file event, or process exit while continuing other work, then resume this persisted session for one agent turn.",
		promptSnippet: "Wait in parallel for a time, file event, or Windows process exit through outer_loop.",
		promptGuidelines: [
			"Use outer_loop only when progress genuinely depends on a future time, file event, or process exit; it does not put the agent to sleep.",
			"A wake event is not a new user instruction and never bypasses permissions or approval policies.",
			"After waking, re-check the requested state before taking external side effects.",
			"wait_time.after accepts milliseconds as a number or an HH:MM:SS duration string; wait_time.at requires a timezone-aware ISO 8601 timestamp.",
			"checkFirst is advisory guidance for the wake turn; the agent must perform those checks itself.",
			"wait_file exposes only exists, missing, modified, and content_changed events; wait_process exposes only exited.",
			"Every monitor must provide timeout.kind, timeout.value, and timeout.onTimeout explicitly.",
			"Cancel an obsolete item with outer_loop.cancel({wakeId}).",
		],
		parameters: OuterLoopSchema,
		prepareArguments: prepareOuterLoopArguments,
		executionMode: "sequential",
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const input = normalizeDurationArguments(params as unknown as Record<string, unknown>) as OuterLoopInput;
			if (input.action === "list") {
				const jobs = await context.store.listBySession(
					ctx.sessionManager.getSessionId(),
					listStatuses(input.includeTerminal),
				);
				return textResult(jobs.length === 0 ? "No outer-loop jobs." : jobs.map(formatJob).join("\n"), { jobs });
			}
			if (input.action === "cancel") {
				const job = await context.store.cancelOwned(input.wakeId, ctx.sessionManager.getSessionId());
				context.onChanged?.();
				return textResult(`Outer-loop job ${job.id} is ${job.status}.`, { job });
			}

			const session = sessionReference(ctx);
			const common = objective(input);
			let createInput: Parameters<WakeStore["createOnce"]>[0];
			if (input.action === "wait_time") {
				const dueAt =
					"after" in input
						? new Date(
								Date.now() +
									checkedDurationMs(
										input.after,
										"after",
										DEFAULT_WAKE_POLICY.minDelayMs,
										DEFAULT_WAKE_POLICY.maxDelayMs,
									),
							).toISOString()
						: parseDateWithPolicy(input.at, "at");
				createInput = {
					requestKey: `${session.id}:${toolCallId}`,
					session,
					...common,
					trigger: { type: "time", dueAt },
				};
			} else {
				const timeoutAt = normalizeIntentTimeout(input.timeout);
				const pollInterval = checkedDurationMs(
					input.pollInterval ?? "00:00:30",
					"pollInterval",
					DEFAULT_WAKE_POLICY.minPollIntervalMs,
					DEFAULT_WAKE_POLICY.maxPollIntervalMs,
				);
				const isFile = input.action === "wait_file";
				const event = input.event;
				const adapter = isFile ? "file_state" : "process_state";
				const source = (
					isFile
						? {
								path: resolveProjectPath(input.path, ctx, context.allowedRoot),
								includeHash: event === "content_changed",
							}
						: { pid: input.pid }
				) as Record<string, JsonValue>;
				createInput = {
					requestKey: `${session.id}:${toolCallId}`,
					session,
					...common,
					trigger: {
						type: "monitor",
						adapter,
						source,
						condition: intentCondition(event),
						intent: isFile
							? { kind: "file", event: event as FileWakeEvent }
							: { kind: "process", event: "exited" },
						delivery: { mode: "poll", intervalMs: pollInterval },
						timeout: { at: timeoutAt, action: input.timeout.onTimeout },
					},
				};
				context.monitorRegistry.require(adapter);
			}

			const result = await context.store.createOnce(normalizeCreateWakeInput(createInput));
			const sampled =
				!result.deduplicated && createInput.trigger.type === "monitor" && context.sampleMonitor
					? await context.sampleMonitor(result.job)
					: undefined;
			const job = sampled ?? result.job;
			context.onChanged?.();
			if (job.status === "ready") context.requestRun?.();
			const description = result.deduplicated
				? `Outer-loop job ${job.id} already exists.`
				: job.trigger.type === "time"
					? `Outer-loop job ${job.id} armed; dueAt=${job.trigger.dueAt}.`
					: job.status === "ready"
						? `Outer-loop job ${job.id} is ready after its initial observation.`
						: `Outer-loop job ${job.id} armed; timeoutAt=${job.trigger.timeout.at}. Initial observation: ${job.triggerRuntime?.lastObservation?.summary ?? "not available"}.`;
			return textResult(description, {
				...result,
				job,
				initialObservation: job.triggerRuntime?.lastObservation,
				monitorError: job.triggerRuntime?.monitorError,
			});
		},
	};
}
