export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WakeStatus =
	| "armed"
	| "ready"
	| "running"
	| "run_retry_wait"
	| "blocked"
	| "cancel_requested"
	| "completed"
	| "cancelled"
	| "expired"
	| "dead_letter";

export type WakeCause = "time_due" | "monitor_match" | "monitor_timeout" | "monitor_error";

export type WakeSource =
	| { kind: "timer"; wakeId: string; scheduledAt: string }
	| { kind: "monitor"; wakeId: string; adapter: string; evidence?: JsonValue; error?: WakeError }
	| {
			kind: "agent";
			claimedFrom: { agentId: string; sessionId?: string; implementation?: string };
			verification: "self_reported";
			message: string;
	  }
	| { kind: "user_cancel"; wakeId: string; note?: string };

/** The stable, intent-level monitor vocabulary exposed by outer_loop. */
export type FileWakeEvent = "exists" | "missing" | "modified" | "content_changed";

export type MonitorIntent = { kind: "file"; event: FileWakeEvent } | { kind: "process"; event: "exited" };

export type WakeObjective = {
	reason: string;
	objective: string;
	checkFirst: string[];
};

export type TimeWakeTrigger = {
	type: "time";
	dueAt: string;
};

export type MonitorCondition = {
	field: string;
	operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists";
	expected?: JsonValue;
	activation: "level" | "transition";
	consecutiveMatches: number;
};

export type MonitorDelivery = { mode: "poll"; intervalMs: number } | { mode: "push"; subscriptionId: string };

export type MonitorTimeout = {
	at: string;
	action: "wake" | "expire";
};

export type MonitorWakeTrigger = {
	type: "monitor";
	adapter: string;
	source: Record<string, JsonValue>;
	condition?: MonitorCondition;
	delivery: MonitorDelivery;
	timeout: MonitorTimeout;
	/** Optional intent metadata. Condition fields remain internal only. */
	intent?: MonitorIntent;
};

export type WakeTrigger = TimeWakeTrigger | MonitorWakeTrigger;

export type MonitorObservation = {
	observedAt: string;
	eventId?: string;
	fields: Record<string, JsonValue>;
	summary: string;
	payloadHash?: string;
};

export type WakeTriggerRuntime = {
	nextCheckAt?: string;
	checkCount: number;
	failureCount: number;
	baselineObserved: boolean;
	consecutiveMatches: number;
	lastObservation?: MonitorObservation;
	evidence?: MonitorObservation;
	monitorError?: WakeError;
	satisfiedAt?: string;
	cause?: WakeCause;
	/** Baseline used by modified/content_changed intent monitors. */
	baselineFingerprint?: string;
};

export type WakeLease = {
	owner: string;
	token: number;
	expiresAt: string;
};

export type WakeError = {
	phase: "monitor" | "restore" | "agent_run";
	code: string;
	message: string;
	retriable: boolean;
	at: string;
};

export type WakeSessionReference = {
	id: string;
	file: string;
	cwd: string;
};

export type WakeJob = WakeObjective & {
	schemaVersion: 2;
	id: string;
	requestKey: string;
	session: WakeSessionReference;
	trigger: WakeTrigger;
	triggerRuntime?: WakeTriggerRuntime;
	status: WakeStatus;
	runAttempt: number;
	maxRunAttempts: number;
	nextRunAttemptAt?: string;
	// Monotonic fencing counter. It must survive lease cleanup and process restarts.
	leaseGeneration?: number;
	lease?: WakeLease;
	lastError?: WakeError;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	/** A user cancellation that should be surfaced on the next normal turn. */
	cancellationNotice?: { note?: string; pending: boolean; createdAt: string };
};

export type CreateWakeInput = WakeObjective & {
	requestKey: string;
	session: WakeSessionReference;
	trigger: WakeTrigger;
	maxRunAttempts?: number;
	now?: string;
};

export type CreateWakeResult = {
	job: WakeJob;
	deduplicated: boolean;
};

export type TriggerResult = {
	cause: WakeCause;
	evidence?: MonitorObservation;
	monitorError?: WakeError;
	satisfiedAt?: string;
};

export type WakeFailure = {
	phase: "monitor" | "restore" | "agent_run";
	code: string;
	message: string;
	retriable: boolean;
	requiresUser?: boolean;
};

export type ClaimedWake = {
	job: WakeJob;
	leaseToken: number;
};

export type MonitorCheckResult = {
	matched: boolean;
	observation: MonitorObservation;
};

export interface WakeStore {
	createOnce(input: CreateWakeInput): Promise<CreateWakeResult>;
	listBySession(sessionId: string, statuses?: WakeStatus[]): Promise<WakeJob[]>;
	cancelOwned(wakeId: string, sessionId: string, now?: string): Promise<WakeJob>;
	/** Cancel without requiring a live AgentSession (used by user/API callers). */
	cancelByUser?(
		wakeId: string,
		note?: string,
		now?: string,
	): Promise<{
		status: "cancelled" | "cancel_requested" | "already_terminal" | "not_found";
		notification: "immediate" | "next_turn";
		job?: WakeJob;
		journalSeq?: number;
	}>;
	listPendingUserNotifications?(
		sessionId: string,
	): Promise<Array<{ wakeId: string; note?: string; createdAt: string }>>;
	acknowledgeUserNotifications?(sessionId: string, wakeIds: string[]): Promise<void>;

	listDueTimeJobs(now: string, limit?: number): Promise<WakeJob[]>;
	listDueRunJobs(now: string, limit?: number): Promise<WakeJob[]>;
	listDueMonitorJobs(now: string, limit?: number): Promise<WakeJob[]>;
	listArmedMonitorJobsBySubscription(subscriptionId: string, limit?: number): Promise<WakeJob[]>;
	markReady(wakeId: string, result: TriggerResult, now?: string): Promise<boolean>;
	recordMonitorObservation(
		wakeId: string,
		observation: MonitorObservation,
		evaluation: {
			rawMatched: boolean;
			matched: boolean;
			nextBaselineObserved: boolean;
			nextConsecutiveMatches: number;
		},
		nextCheckAt?: string,
		now?: string,
	): Promise<boolean>;
	recordMonitorFailure(wakeId: string, failure: WakeFailure, nextCheckAt?: string, now?: string): Promise<boolean>;
	expire(wakeId: string, now?: string): Promise<boolean>;

	claimReady(wakeId: string, workerId: string, leaseMs: number, now?: string): Promise<ClaimedWake | null>;
	heartbeat(wakeId: string, leaseToken: number, leaseMs: number, now?: string): Promise<boolean>;
	completeRun(wakeId: string, leaseToken: number, now?: string): Promise<boolean>;
	retryRunLater(
		wakeId: string,
		leaseToken: number,
		failure: WakeFailure,
		nextAttemptAt: string,
		now?: string,
	): Promise<boolean>;
	block(wakeId: string, leaseToken: number, failure: WakeFailure, now?: string): Promise<boolean>;
	moveToDeadLetter(wakeId: string, leaseToken: number, failure: WakeFailure, now?: string): Promise<boolean>;
	reapExpiredLeases(now?: string): Promise<number>;
}
