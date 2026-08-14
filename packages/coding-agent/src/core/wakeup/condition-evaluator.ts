import type { MonitorCondition, MonitorObservation, WakeJob } from "./types.ts";

function getField(fields: Record<string, unknown>, path: string): unknown {
	let current: unknown = fields;
	for (const part of path.split(".")) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function equalValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function matchesRaw(condition: MonitorCondition, observation: MonitorObservation): boolean {
	const actual = getField(observation.fields, condition.field);
	if (actual === undefined && condition.operator !== "exists") return false;
	switch (condition.operator) {
		case "exists":
			// Built-in adapters expose a semantic `exists: boolean` field. Treat
			// operator=exists on that field as the natural existence intent rather
			// than merely testing that the metadata key is present.
			return actual !== undefined && (condition.field !== "exists" || actual === true);
		case "eq":
			return equalValue(actual, condition.expected);
		case "ne":
			return !equalValue(actual, condition.expected);
		case "gt":
			return typeof actual === "number" && typeof condition.expected === "number" && actual > condition.expected;
		case "gte":
			return typeof actual === "number" && typeof condition.expected === "number" && actual >= condition.expected;
		case "lt":
			return typeof actual === "number" && typeof condition.expected === "number" && actual < condition.expected;
		case "lte":
			return typeof actual === "number" && typeof condition.expected === "number" && actual <= condition.expected;
		case "in":
			return Array.isArray(condition.expected) && condition.expected.some((item) => equalValue(item, actual));
		case "contains":
			return typeof actual === "string" && typeof condition.expected === "string"
				? actual.includes(condition.expected)
				: Array.isArray(actual) && actual.some((item) => equalValue(item, condition.expected));
	}
}

export type MonitorEvaluation = {
	rawMatched: boolean;
	matched: boolean;
	nextBaselineObserved: boolean;
	nextConsecutiveMatches: number;
	nextBaselineFingerprint?: string;
};

function stableFingerprint(value: Record<string, unknown>): string {
	return JSON.stringify(value, Object.keys(value).sort());
}

function intentMatch(
	job: WakeJob,
	observation: MonitorObservation,
): { matched: boolean; fingerprint?: string } | undefined {
	const intent = job.trigger.type === "monitor" ? job.trigger.intent : undefined;
	if (!intent) return undefined;
	if (intent.kind === "process") {
		return { matched: observation.fields.status === "exited" || observation.fields.status === "not_found" };
	}
	const exists = observation.fields.exists === true;
	if (intent.event === "exists") return { matched: exists };
	if (intent.event === "missing") return { matched: !exists };
	const fingerprint =
		intent.event === "content_changed"
			? String(observation.fields.sha256 ?? "")
			: stableFingerprint({
					exists: observation.fields.exists,
					type: observation.fields.type,
					size: observation.fields.size,
					mtimeMs: observation.fields.mtimeMs,
					ctimeMs: observation.fields.ctimeMs,
				});
	return {
		matched: Boolean(
			job.triggerRuntime?.baselineFingerprint && job.triggerRuntime.baselineFingerprint !== fingerprint,
		),
		fingerprint,
	};
}

export function evaluateMonitorCondition(job: WakeJob, observation: MonitorObservation): MonitorEvaluation {
	if (job.trigger.type !== "monitor") {
		throw new Error("Cannot evaluate a non-monitor Wake Job");
	}
	const condition = job.trigger.condition ?? {
		field: "exists",
		operator: "exists" as const,
		activation: "level" as const,
		consecutiveMatches: 1,
	};
	const intentResult = intentMatch(job, observation);
	const rawMatched = intentResult?.matched ?? matchesRaw(condition, observation);
	const previousRuntime = job.triggerRuntime;
	const previousConsecutive = previousRuntime?.consecutiveMatches ?? 0;
	const nextConsecutiveMatches = rawMatched ? previousConsecutive + 1 : 0;

	const isInitialObservation = (previousRuntime?.checkCount ?? 0) === 0;
	// The initial sample is authoritative: an already-satisfied process or file
	// condition must wake immediately. After that, transition monitors still require
	// a previously observed non-match.
	const nextBaselineObserved =
		condition.activation === "transition" ? Boolean(previousRuntime?.baselineObserved) || !rawMatched : true;
	const activationMatched =
		condition.activation === "level" || isInitialObservation || (nextBaselineObserved && rawMatched);
	return {
		rawMatched,
		matched:
			rawMatched && isInitialObservation
				? true
				: activationMatched && nextConsecutiveMatches >= condition.consecutiveMatches,
		nextBaselineObserved,
		nextConsecutiveMatches,
		nextBaselineFingerprint: intentResult?.fingerprint,
	};
}
