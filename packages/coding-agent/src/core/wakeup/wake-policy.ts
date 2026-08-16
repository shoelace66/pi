import type {
	CreateWakeInput,
	MonitorCondition,
	MonitorDelivery,
	MonitorWakeTrigger,
	WakeObjective,
	WakeTrigger,
} from "./types.ts";

export const DEFAULT_WAKE_POLICY = {
	minDelayMs: 60_000,
	maxDelayMs: 30 * 24 * 60 * 60 * 1000,
	maxMonitorDurationMs: 7 * 24 * 60 * 60 * 1000,
	minPollIntervalMs: 30_000,
	maxPollIntervalMs: 24 * 60 * 60 * 1000,
	maxReasonLength: 200,
	maxObjectiveLength: 2_000,
	maxCheckFirstItems: 5,
	maxCheckFirstItemLength: 300,
	maxSourceKeys: 32,
	maxRunAttempts: 3,
} as const;

// A timestamp built from `Date.now() + 60000` can lose a few milliseconds
// before validation runs. Keep the one-minute contract while avoiding a
// surprising rejection at that exact boundary.
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

export class WakePolicyError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WakePolicyError";
		this.code = code;
	}
}

function formatDuration(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	const absolute = Math.abs(ms);
	if (absolute % 86_400_000 === 0)
		return `${sign}${absolute / 86_400_000} day${absolute / 86_400_000 === 1 ? "" : "s"}`;
	if (absolute % 3_600_000 === 0) return `${sign}${absolute / 3_600_000} hour${absolute / 3_600_000 === 1 ? "" : "s"}`;
	if (absolute % 60_000 === 0) return `${sign}${absolute / 60_000} minute${absolute / 60_000 === 1 ? "" : "s"}`;
	if (absolute % 1_000 === 0) return `${sign}${absolute / 1_000} second${absolute / 1_000 === 1 ? "" : "s"}`;
	return `${ms}ms`;
}

function formatMilliseconds(ms: number): string {
	return `${ms}ms (${formatDuration(ms)})`;
}

function requireText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new WakePolicyError("WAKE_INVALID_TEXT", `${field} must be a non-empty string`);
	}
	if (value.length > maxLength) {
		throw new WakePolicyError("WAKE_TEXT_TOO_LONG", `${field} exceeds ${maxLength} characters`);
	}
	return value.trim();
}

function parseDate(value: string, field: string): string {
	if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value)) {
		throw new WakePolicyError(
			"WAKE_TIMEZONE_REQUIRED",
			`${field}=${JSON.stringify(value)} must include an explicit timezone. Use an ISO 8601 value such as 2026-08-13T18:00:00+08:00.`,
		);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new WakePolicyError(
			"WAKE_INVALID_TIME",
			`${field}=${JSON.stringify(value)} is not a valid ISO 8601 time. Include a timezone offset or Z, for example 2026-08-13T18:00:00+08:00.`,
		);
	}
	return date.toISOString();
}

function normalizeObjective(input: WakeObjective): WakeObjective {
	const checkFirst = input.checkFirst ?? [];
	if (!Array.isArray(checkFirst) || checkFirst.length > DEFAULT_WAKE_POLICY.maxCheckFirstItems) {
		throw new WakePolicyError(
			"WAKE_INVALID_CHECKS",
			`checkFirst must contain at most ${DEFAULT_WAKE_POLICY.maxCheckFirstItems} items`,
		);
	}
	return {
		reason: requireText(input.reason, "reason", DEFAULT_WAKE_POLICY.maxReasonLength),
		objective: requireText(input.objective, "objective", DEFAULT_WAKE_POLICY.maxObjectiveLength),
		checkFirst: checkFirst.map((item, index) =>
			requireText(item, `checkFirst[${index}]`, DEFAULT_WAKE_POLICY.maxCheckFirstItemLength),
		),
	};
}

function assertTriggerWindow(trigger: WakeTrigger, now: Date): WakeTrigger {
	if (trigger.type === "time") {
		const dueAt = parseDate(trigger.dueAt, "dueAt");
		const delay = new Date(dueAt).getTime() - now.getTime();
		if (delay < DEFAULT_WAKE_POLICY.minDelayMs && delay < DEFAULT_WAKE_POLICY.minDelayMs - CLOCK_SKEW_TOLERANCE_MS) {
			throw new WakePolicyError(
				"WAKE_TOO_SOON",
				`dueAt=${dueAt} is only ${formatMilliseconds(delay)} from now. The minimum is ${formatMilliseconds(DEFAULT_WAKE_POLICY.minDelayMs)}. For trigger.kind="after", pass delayMs in milliseconds (60 seconds = 60000), or use an absolute ISO 8601 timestamp at least 1 minute in the future.`,
			);
		}
		if (delay > DEFAULT_WAKE_POLICY.maxDelayMs) {
			throw new WakePolicyError(
				"WAKE_TOO_FAR",
				`dueAt=${dueAt} is ${formatMilliseconds(delay)} from now. The maximum is ${formatMilliseconds(DEFAULT_WAKE_POLICY.maxDelayMs)}. Reduce trigger.delayMs or choose an earlier absolute time; delayMs is milliseconds, not seconds.`,
			);
		}
		return { type: "time", dueAt };
	}

	const timeoutAt = parseDate(trigger.timeout.at, "monitor.timeout.at");
	const timeoutDelay = new Date(timeoutAt).getTime() - now.getTime();
	if (
		timeoutDelay < DEFAULT_WAKE_POLICY.minDelayMs &&
		timeoutDelay < DEFAULT_WAKE_POLICY.minDelayMs - CLOCK_SKEW_TOLERANCE_MS
	) {
		throw new WakePolicyError(
			"MONITOR_TIMEOUT_TOO_SOON",
			`monitor.timeout.at=${timeoutAt} is only ${formatMilliseconds(timeoutDelay)} from now. The minimum timeout window is ${formatMilliseconds(DEFAULT_WAKE_POLICY.minDelayMs)}. Use an absolute ISO 8601 timestamp at least 1 minute in the future.`,
		);
	}
	if (timeoutDelay > DEFAULT_WAKE_POLICY.maxMonitorDurationMs) {
		throw new WakePolicyError(
			"MONITOR_TIMEOUT_TOO_FAR",
			`monitor.timeout.at=${timeoutAt} is ${formatMilliseconds(timeoutDelay)} from now. The maximum monitor duration is ${formatMilliseconds(DEFAULT_WAKE_POLICY.maxMonitorDurationMs)}. Choose a timeout within 7 days.`,
		);
	}
	return { ...trigger, timeout: { ...trigger.timeout, at: timeoutAt } };
}

function normalizeCondition(condition: MonitorCondition): MonitorCondition {
	if (typeof condition.field !== "string" || !/^[A-Za-z0-9_.-]+$/.test(condition.field)) {
		throw new WakePolicyError("MONITOR_INVALID_FIELD", "monitor condition field must be a safe dotted field path");
	}
	if (condition.activation !== "level" && condition.activation !== "transition") {
		throw new WakePolicyError("MONITOR_INVALID_ACTIVATION", "activation must be level or transition");
	}
	const consecutiveMatches = condition.consecutiveMatches ?? 1;
	if (!Number.isInteger(consecutiveMatches) || consecutiveMatches < 1 || consecutiveMatches > 100) {
		throw new WakePolicyError("MONITOR_INVALID_MATCH_COUNT", "consecutiveMatches must be an integer from 1 to 100");
	}
	if (condition.operator === "exists" && condition.expected !== undefined) {
		throw new WakePolicyError("MONITOR_UNEXPECTED_VALUE", "exists condition must not provide expected");
	}
	if (condition.operator !== "exists" && condition.expected === undefined) {
		throw new WakePolicyError("MONITOR_EXPECTED_REQUIRED", "expected is required for this condition operator");
	}
	return { ...condition, consecutiveMatches };
}

function normalizeDelivery(delivery: MonitorDelivery): MonitorDelivery {
	if (delivery.mode === "poll") {
		if (!Number.isInteger(delivery.intervalMs) || delivery.intervalMs < DEFAULT_WAKE_POLICY.minPollIntervalMs) {
			throw new WakePolicyError(
				"MONITOR_POLL_TOO_FAST",
				`pollIntervalMs=${JSON.stringify(delivery.intervalMs)} is below the minimum of ${formatMilliseconds(DEFAULT_WAKE_POLICY.minPollIntervalMs)}. This field is milliseconds, not seconds; use 30000 for 30 seconds.`,
			);
		}
		if (delivery.intervalMs > DEFAULT_WAKE_POLICY.maxPollIntervalMs) {
			throw new WakePolicyError(
				"MONITOR_POLL_TOO_SLOW",
				`pollIntervalMs=${delivery.intervalMs} (${formatDuration(delivery.intervalMs)}) exceeds the maximum of ${formatMilliseconds(DEFAULT_WAKE_POLICY.maxPollIntervalMs)}. Use a value from 30000ms (30 seconds) through 86400000ms (24 hours).`,
			);
		}
		return delivery;
	}
	if (delivery.mode === "push" && (!delivery.subscriptionId || delivery.subscriptionId.length > 200)) {
		throw new WakePolicyError(
			"MONITOR_INVALID_SUBSCRIPTION",
			"subscriptionId must be a valid configured subscription",
		);
	}
	return delivery;
}

function normalizeMonitorTrigger(trigger: MonitorWakeTrigger): MonitorWakeTrigger {
	if (!trigger.adapter || !/^[A-Za-z0-9_.-]+$/.test(trigger.adapter)) {
		throw new WakePolicyError("MONITOR_INVALID_ADAPTER", "adapter must be a registered adapter name");
	}
	if (Object.keys(trigger.source).length > DEFAULT_WAKE_POLICY.maxSourceKeys) {
		throw new WakePolicyError("MONITOR_SOURCE_TOO_LARGE", "monitor source has too many keys");
	}
	if (!trigger.condition) {
		throw new WakePolicyError("MONITOR_CONDITION_REQUIRED", "monitor condition is required");
	}
	return {
		...trigger,
		condition: normalizeCondition(trigger.condition),
		delivery: normalizeDelivery(trigger.delivery),
	};
}

export function normalizeCreateWakeInput(input: CreateWakeInput, now = new Date()): CreateWakeInput {
	const trigger = assertTriggerWindow(input.trigger, now);
	const normalizedTrigger = trigger.type === "monitor" ? normalizeMonitorTrigger(trigger) : trigger;
	const objective = normalizeObjective(input);
	const maxRunAttempts = input.maxRunAttempts ?? DEFAULT_WAKE_POLICY.maxRunAttempts;
	if (!Number.isInteger(maxRunAttempts) || maxRunAttempts < 1 || maxRunAttempts > DEFAULT_WAKE_POLICY.maxRunAttempts) {
		throw new WakePolicyError(
			"WAKE_INVALID_ATTEMPTS",
			`maxRunAttempts must be from 1 to ${DEFAULT_WAKE_POLICY.maxRunAttempts}`,
		);
	}
	if (!input.requestKey || input.requestKey.length > 500) {
		throw new WakePolicyError("WAKE_INVALID_REQUEST_KEY", "requestKey is required and must be short");
	}
	if (!input.session.id || !input.session.file || !input.session.cwd) {
		throw new WakePolicyError("WAKE_INVALID_SESSION", "session id, file, and cwd are required");
	}
	return {
		...input,
		...objective,
		trigger: normalizedTrigger,
		maxRunAttempts,
		now: now.toISOString(),
	};
}
