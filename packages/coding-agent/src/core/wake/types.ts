export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WakeCapabilityAddress = string & { readonly __wakeCapabilityAddress: unique symbol };

export type WakeEvent = {
	eventId: string;
	message: string;
	data?: JsonValue;
};

export type WakeProducer = {
	id: string;
	name?: string;
};

export type WakeRegistrationInput = {
	requestKey: string;
	producer: WakeProducer;
	reason: string;
	objective: string;
	checkFirst?: string[];
	expiresAt?: string;
};

export type WakeReceipt = {
	status: "accepted" | "duplicate";
	requestId: string;
};

export type WakeOutcomeStatus = "completed" | "retryable" | "blocked" | "cancelled" | "rejected";

export type WakeOutcome = {
	requestId: string;
	status: WakeOutcomeStatus;
	error?: { code: string; message: string; retriable: boolean };
};

export type WakeRegistrationInfo = WakeRegistrationInput & {
	id: string;
	status: "armed" | "accepted" | "completed" | "cancelled" | "expired" | "failed";
	createdAt: string;
	updatedAt: string;
};

export interface WakeRegistration {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly outcome: Promise<WakeOutcome>;
	emit(event: WakeEvent): Promise<WakeReceipt>;
	createCapability(): Promise<WakeCapabilityAddress>;
	cancel(reason?: string): Promise<boolean>;
}

export interface WakeInbox {
	readonly address: WakeCapabilityAddress;
	revoke(): Promise<boolean>;
}

export interface WakeContext {
	register(input: WakeRegistrationInput): Promise<WakeRegistration>;
	list(): Promise<WakeRegistrationInfo[]>;
	cancel(registrationId: string, reason?: string): Promise<boolean>;
	openInbox(): Promise<WakeInbox>;
	rotateInbox(): Promise<WakeInbox>;
	revokeInbox(): Promise<boolean>;
	send(address: WakeCapabilityAddress | string, event: WakeEvent): Promise<WakeReceipt>;
}

export type WakeSessionReference = {
	id: string;
	file: string;
	cwd: string;
};

export type WakeSource =
	| { kind: "registration"; registrationId: string; producer: WakeProducer }
	| { kind: "agent"; sessionId: string; verification: "self_reported" }
	| { kind: "external"; verification: "capability" };

export type WakeEnvelope = {
	schemaVersion: 1;
	resourceId: string;
	requestId: string;
	receivedAt: string;
	target: { kind: "pi_session"; sessionId: string };
	source: WakeSource;
	event: WakeEvent;
	registration?: Pick<WakeRegistrationInput, "reason" | "objective" | "checkFirst"> & { id: string };
};

export type WakeClientErrorCode =
	| "WAKE_INVALID_ADDRESS"
	| "WAKE_INVALID_EVENT"
	| "WAKE_UNAUTHORIZED"
	| "WAKE_REVOKED"
	| "WAKE_OFFLINE"
	| "WAKE_BUSY"
	| "WAKE_SESSION_NOT_PERSISTED"
	| "WAKE_SESSION_OWNED"
	| "WAKE_RUNTIME_STOPPED"
	| "WAKE_INTERNAL";

export class WakeClientError extends Error {
	readonly code: WakeClientErrorCode;
	readonly retryAfterMs?: number;

	constructor(code: WakeClientErrorCode, message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WakeClientError";
		this.code = code;
		this.retryAfterMs = options?.retryAfterMs;
	}
}
