import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { AgentSession } from "../agent-session.ts";
import { SessionManager } from "../session-manager.ts";
import { createCapabilityToken, encodeWakeCapability, hashCapabilityToken, validateWakeEvent } from "./capability.ts";
import { WakeClient } from "./client.ts";
import { InMemoryWakeJournal, type WakeJournal } from "./journal.ts";
import { composeWakeEventPrompt } from "./prompt.ts";
import type {
	WakeCapabilityAddress,
	WakeContext,
	WakeEnvelope,
	WakeEvent,
	WakeInbox,
	WakeOutcome,
	WakeReceipt,
	WakeRegistration,
	WakeRegistrationInfo,
	WakeRegistrationInput,
	WakeSessionReference,
	WakeSource,
} from "./types.ts";
import { WakeClientError } from "./types.ts";
import {
	encodeWakeFrame,
	WAKE_WIRE_VERSION,
	WakeFrameDecoder,
	type WakeWireRequest,
	type WakeWireResponse,
} from "./wire.ts";

const DEFAULT_MAX_PENDING_PER_SESSION = 32;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_DEDUPE_ENTRIES = 4_096;

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

class SessionMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolveTail) => {
			release = resolveTail;
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}
}

type SessionBinding = {
	ref: WakeSessionReference;
	liveSession?: AgentSession;
	releaseOwnership: () => Promise<void>;
};

type RegistrationState = {
	info: WakeRegistrationInfo;
	session: WakeSessionReference;
	abortController: AbortController;
	outcome: Deferred<WakeOutcome>;
	timer?: ReturnType<typeof setTimeout>;
	capabilityId?: string;
};

type CapabilityState = {
	id: string;
	kind: "registration" | "inbox";
	session: WakeSessionReference;
	token: string;
	tokenHash: string;
	registrationId?: string;
	revoked: boolean;
	consumed: boolean;
};

type QueueState = {
	pending: number;
	tail: Promise<void>;
};

type DedupeState = {
	receipt: WakeReceipt;
};

export type WakeRuntimeOptions = {
	agentDir: string;
	journal?: WakeJournal;
	maxPendingPerSession?: number;
	createSession?: (sessionFile: string, cwd: string) => Promise<AgentSession>;
};

export type WakeBindResult =
	| { owned: true; context: WakeContext }
	| { owned: false; error: WakeClientError; context: WakeContext };

function validateRegistrationInput(input: WakeRegistrationInput): WakeRegistrationInput {
	if (!input || typeof input !== "object")
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake registration is required");
	for (const [name, value] of [
		["requestKey", input.requestKey],
		["producer.id", input.producer?.id],
		["reason", input.reason],
		["objective", input.objective],
	] as const) {
		if (typeof value !== "string" || value.trim().length === 0)
			throw new WakeClientError("WAKE_INVALID_EVENT", `${name} must be a non-empty string`);
	}
	if (input.checkFirst && !input.checkFirst.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "checkFirst must contain non-empty strings");
	}
	if (input.expiresAt) {
		const expiresAt = new Date(input.expiresAt).getTime();
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			throw new WakeClientError("WAKE_INVALID_EVENT", "expiresAt must be a future ISO 8601 timestamp");
		}
	}
	return JSON.parse(JSON.stringify(input)) as WakeRegistrationInput;
}

function classifyError(error: unknown): NonNullable<WakeOutcome["error"]> {
	const message = error instanceof Error ? error.message : String(error);
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code)
			: "WAKE_DISPATCH_FAILED";
	const blocked = /auth|credential|permission|approval|api key|model|not found|persisted/i.test(message);
	return { code, message, retriable: !blocked };
}

function safeSource(source: WakeSource | undefined): WakeSource {
	if (source?.kind === "agent" && typeof source.sessionId === "string" && source.sessionId.length > 0) {
		return { kind: "agent", sessionId: source.sessionId, verification: "self_reported" };
	}
	return { kind: "external", verification: "capability" };
}

export class WakeRuntime {
	readonly journal: WakeJournal;
	private readonly agentDir: string;
	private readonly maxPendingPerSession: number;
	private readonly createSession?: (sessionFile: string, cwd: string) => Promise<AgentSession>;
	private readonly client = new WakeClient();
	private readonly bindingsByFile = new Map<string, SessionBinding>();
	private readonly bindingsById = new Map<string, SessionBinding>();
	private readonly ownershipErrors = new Map<string, WakeClientError>();
	private readonly registrations = new Map<string, RegistrationState>();
	private readonly requestKeys = new Map<string, string>();
	private readonly capabilities = new Map<string, CapabilityState>();
	private readonly inboxes = new Map<string, string>();
	private readonly queues = new Map<string, QueueState>();
	private readonly mutexes = new Map<string, SessionMutex>();
	private readonly dedupe = new Map<string, DedupeState>();
	private server?: Server;
	private endpoint?: string;
	private startPromise?: Promise<void>;
	private stopped = false;

	constructor(options: WakeRuntimeOptions) {
		this.agentDir = resolve(options.agentDir);
		this.journal = options.journal ?? new InMemoryWakeJournal();
		this.maxPendingPerSession = options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
		this.createSession = options.createSession;
	}

	async start(): Promise<void> {
		if (this.stopped) throw new WakeClientError("WAKE_RUNTIME_STOPPED", "Wake runtime has stopped");
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startServer();
		return this.startPromise;
	}

	async bindSession(session: AgentSession): Promise<WakeBindResult> {
		const file = session.sessionFile;
		const ref = file
			? { id: session.sessionManager.getSessionId(), file: resolve(file), cwd: session.sessionManager.getCwd() }
			: undefined;
		if (!ref) {
			const error = new WakeClientError("WAKE_SESSION_NOT_PERSISTED", "Wake requires a persisted AgentSession");
			return { owned: false, error, context: this.unavailableContext(error) };
		}
		await this.start();
		const existing = this.bindingsByFile.get(ref.file);
		if (existing) {
			existing.liveSession = session;
			return { owned: true, context: this.contextFor(ref) };
		}
		try {
			const releaseOwnership = await this.acquireOwnership(ref);
			const binding = { ref, liveSession: session, releaseOwnership };
			this.bindingsByFile.set(ref.file, binding);
			this.bindingsById.set(ref.id, binding);
			this.ownershipErrors.delete(ref.id);
			return { owned: true, context: this.contextFor(ref) };
		} catch (error) {
			const ownedError = new WakeClientError(
				"WAKE_SESSION_OWNED",
				"Another Pi process already owns the Wake endpoint for this session",
				{ cause: error },
			);
			this.ownershipErrors.set(ref.id, ownedError);
			return { owned: false, error: ownedError, context: this.unavailableContext(ownedError) };
		}
	}

	unbindSession(sessionFile?: string): void {
		if (!sessionFile) {
			for (const binding of this.bindingsByFile.values()) binding.liveSession = undefined;
			return;
		}
		const binding = this.bindingsByFile.get(resolve(sessionFile));
		if (binding) binding.liveSession = undefined;
	}

	contextForSession(session: AgentSession): WakeContext | undefined {
		const file = session.sessionFile;
		if (!file) return undefined;
		const ref = {
			id: session.sessionManager.getSessionId(),
			file: resolve(file),
			cwd: session.sessionManager.getCwd(),
		};
		return this.contextFor(ref);
	}

	contextFor(ref: WakeSessionReference): WakeContext {
		const session = { ...ref, file: resolve(ref.file) };
		return {
			register: (input) => this.register(session, input),
			list: () => this.listRegistrations(session.id),
			cancel: (registrationId, reason) => this.cancelRegistration(session.id, registrationId, reason),
			openInbox: () => this.openInbox(session, false),
			rotateInbox: () => this.openInbox(session, true),
			revokeInbox: () => this.revokeInbox(session.id),
			send: (address, event) =>
				this.client.emitWithSource(address, event, {
					kind: "agent",
					sessionId: session.id,
					verification: "self_reported",
				}),
		};
	}

	async runExclusive<T>(sessionFile: string, task: () => Promise<T>): Promise<T> {
		return this.mutex(resolve(sessionFile)).run(task);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const registration of this.registrations.values()) {
			if (!registration.abortController.signal.aborted) {
				registration.info.status = "cancelled";
				registration.info.updatedAt = new Date().toISOString();
				registration.abortController.abort("Wake runtime stopped");
				registration.outcome.resolve({ requestId: registration.info.id, status: "cancelled" });
			}
			if (registration.timer) clearTimeout(registration.timer);
		}
		for (const capability of this.capabilities.values()) capability.revoked = true;
		await this.closeServer();
		await Promise.allSettled([...this.bindingsByFile.values()].map((binding) => binding.releaseOwnership()));
		this.bindingsByFile.clear();
		this.bindingsById.clear();
	}

	private unavailableContext(error: WakeClientError): WakeContext {
		const reject = async (): Promise<never> => {
			throw error;
		};
		return {
			register: reject,
			list: reject,
			cancel: reject,
			openInbox: reject,
			rotateInbox: reject,
			revokeInbox: reject,
			send: reject,
		};
	}

	private requireOwnedSession(ref: WakeSessionReference): SessionBinding {
		if (this.stopped) throw new WakeClientError("WAKE_RUNTIME_STOPPED", "Wake runtime has stopped");
		const ownershipError = this.ownershipErrors.get(ref.id);
		if (ownershipError) throw ownershipError;
		const binding = this.bindingsById.get(ref.id);
		if (!binding || binding.ref.file !== resolve(ref.file)) {
			throw new WakeClientError("WAKE_SESSION_OWNED", "This process does not own Wake for the target session");
		}
		return binding;
	}

	private async register(ref: WakeSessionReference, rawInput: WakeRegistrationInput): Promise<WakeRegistration> {
		this.requireOwnedSession(ref);
		const input = validateRegistrationInput(rawInput);
		const key = `${ref.id}:${input.requestKey}`;
		const existingId = this.requestKeys.get(key);
		if (existingId) {
			const existing = this.registrations.get(existingId);
			if (existing) return this.registrationHandle(existing);
		}
		const now = new Date().toISOString();
		const id = `wake_reg_${randomUUID().replaceAll("-", "")}`;
		const state: RegistrationState = {
			info: { ...input, id, status: "armed", createdAt: now, updatedAt: now },
			session: { ...ref, file: resolve(ref.file) },
			abortController: new AbortController(),
			outcome: deferred<WakeOutcome>(),
		};
		if (input.expiresAt) {
			const delay = Math.min(2_147_483_647, new Date(input.expiresAt).getTime() - Date.now());
			state.timer = setTimeout(() => void this.expireRegistration(state), delay);
			state.timer.unref();
		}
		this.registrations.set(id, state);
		this.requestKeys.set(key, id);
		return this.registrationHandle(state);
	}

	private registrationHandle(state: RegistrationState): WakeRegistration {
		return {
			id: state.info.id,
			signal: state.abortController.signal,
			outcome: state.outcome.promise,
			emit: (event) =>
				this.submitDirect(state, event, {
					kind: "registration",
					registrationId: state.info.id,
					producer: state.info.producer,
				}),
			createCapability: () => this.createRegistrationCapability(state),
			cancel: (reason) => this.cancelRegistration(state.session.id, state.info.id, reason),
		};
	}

	private async createRegistrationCapability(state: RegistrationState): Promise<WakeCapabilityAddress> {
		this.requireOwnedSession(state.session);
		if (state.info.status !== "armed")
			throw new WakeClientError("WAKE_REVOKED", "Wake registration is no longer armed");
		if (state.capabilityId) return this.addressFor(this.capabilities.get(state.capabilityId)!);
		const capability = this.createCapability("registration", state.session, state.info.id);
		state.capabilityId = capability.id;
		return this.addressFor(capability);
	}

	private async openInbox(ref: WakeSessionReference, rotate: boolean): Promise<WakeInbox> {
		this.requireOwnedSession(ref);
		const existingId = this.inboxes.get(ref.id);
		if (existingId && !rotate) {
			const existing = this.capabilities.get(existingId);
			if (existing && !existing.revoked) return this.inboxHandle(existing);
		}
		if (existingId) await this.revokeCapability(existingId);
		const capability = this.createCapability("inbox", ref);
		this.inboxes.set(ref.id, capability.id);
		return this.inboxHandle(capability);
	}

	private inboxHandle(capability: CapabilityState): WakeInbox {
		return {
			address: this.addressFor(capability),
			revoke: () => this.revokeCapability(capability.id),
		};
	}

	private async revokeInbox(sessionId: string): Promise<boolean> {
		const id = this.inboxes.get(sessionId);
		if (!id) return false;
		this.inboxes.delete(sessionId);
		return this.revokeCapability(id);
	}

	private createCapability(
		kind: CapabilityState["kind"],
		session: WakeSessionReference,
		registrationId?: string,
	): CapabilityState {
		if (!this.endpoint) throw new WakeClientError("WAKE_RUNTIME_STOPPED", "Wake IPC endpoint is not running");
		const id = `wake_${randomUUID().replaceAll("-", "")}`;
		const token = createCapabilityToken();
		const state: CapabilityState = {
			id,
			kind,
			session: { ...session },
			token,
			tokenHash: hashCapabilityToken(token),
			registrationId,
			revoked: false,
			consumed: false,
		};
		this.capabilities.set(id, state);
		return state;
	}

	private addressFor(capability: CapabilityState): WakeCapabilityAddress {
		if (!this.endpoint) throw new WakeClientError("WAKE_RUNTIME_STOPPED", "Wake IPC endpoint is not running");
		return encodeWakeCapability(
			{ endpoint: this.endpoint, resourceId: capability.id, kind: capability.kind },
			capability.token,
		);
	}

	private async revokeCapability(id: string): Promise<boolean> {
		const capability = this.capabilities.get(id);
		if (!capability || capability.revoked) return false;
		capability.revoked = true;
		await this.journal.append({ kind: "revoked", resourceId: id, target: capability.session as never });
		return true;
	}

	private async cancelRegistration(sessionId: string, registrationId: string, reason?: string): Promise<boolean> {
		const state = this.registrations.get(registrationId);
		if (!state || state.session.id !== sessionId || state.info.status !== "armed") return false;
		state.info.status = "cancelled";
		state.info.updatedAt = new Date().toISOString();
		if (state.timer) clearTimeout(state.timer);
		state.abortController.abort(reason ?? "Wake registration cancelled");
		if (state.capabilityId) await this.revokeCapability(state.capabilityId);
		state.outcome.resolve({ requestId: state.info.id, status: "cancelled" });
		await this.journal.append({
			kind: "cancelled",
			resourceId: registrationId,
			target: state.session as never,
			data: { reason: reason ?? null } as never,
		});
		return true;
	}

	private async expireRegistration(state: RegistrationState): Promise<void> {
		if (state.info.status !== "armed") return;
		state.info.status = "expired";
		state.info.updatedAt = new Date().toISOString();
		state.abortController.abort("Wake registration expired");
		if (state.capabilityId) await this.revokeCapability(state.capabilityId);
		state.outcome.resolve({ requestId: state.info.id, status: "cancelled" });
		await this.journal.append({ kind: "cancelled", resourceId: state.info.id, data: { expired: true } as never });
	}

	private async listRegistrations(sessionId: string): Promise<WakeRegistrationInfo[]> {
		return [...this.registrations.values()]
			.filter((state) => state.session.id === sessionId)
			.map((state) => JSON.parse(JSON.stringify(state.info)) as WakeRegistrationInfo);
	}

	private async submitDirect(state: RegistrationState, event: WakeEvent, source: WakeSource): Promise<WakeReceipt> {
		const validated = validateWakeEvent(event);
		const duplicate = this.dedupe.get(`${state.info.id}:${validated.eventId}`);
		if (duplicate) {
			await this.journal.append({
				kind: "duplicate",
				resourceId: state.info.id,
				requestId: duplicate.receipt.requestId,
				data: { eventId: validated.eventId } as never,
			});
			return { ...duplicate.receipt, status: "duplicate" };
		}
		if (state.info.status !== "armed")
			throw new WakeClientError("WAKE_REVOKED", "Wake registration is no longer armed");
		return this.acceptEvent(
			{
				id: state.info.id,
				kind: "registration",
				session: state.session,
				token: "",
				tokenHash: "",
				registrationId: state.info.id,
				revoked: false,
				consumed: false,
			},
			validated,
			source,
		);
	}

	private async acceptWireRequest(request: WakeWireRequest): Promise<WakeReceipt> {
		try {
			if (!request || typeof request !== "object" || request.version !== WAKE_WIRE_VERSION) {
				throw new WakeClientError("WAKE_INVALID_EVENT", "Unsupported Wake IPC protocol version");
			}
			if (typeof request.resourceId !== "string" || typeof request.token !== "string") {
				throw new WakeClientError("WAKE_UNAUTHORIZED", "Wake capability is invalid");
			}
			const capability = this.capabilities.get(request.resourceId);
			if (!capability || !this.matchesToken(capability, request.token)) {
				throw new WakeClientError("WAKE_UNAUTHORIZED", "Wake capability is invalid");
			}
			return await this.acceptEvent(capability, validateWakeEvent(request.event), safeSource(request.source));
		} catch (error) {
			const wakeError =
				error instanceof WakeClientError
					? error
					: new WakeClientError("WAKE_INVALID_EVENT", "Wake IPC request is invalid", { cause: error });
			await this.journal.append({
				kind: "rejected",
				resourceId: typeof request?.resourceId === "string" ? request.resourceId : undefined,
				error: { code: wakeError.code, message: wakeError.message } as never,
			});
			throw wakeError;
		}
	}

	private async acceptEvent(capability: CapabilityState, event: WakeEvent, source: WakeSource): Promise<WakeReceipt> {
		const dedupeKey = `${capability.id}:${event.eventId}`;
		const duplicate = this.dedupe.get(dedupeKey);
		if (duplicate) {
			await this.journal.append({
				kind: "duplicate",
				resourceId: capability.id,
				requestId: duplicate.receipt.requestId,
				data: { eventId: event.eventId } as never,
			});
			return { ...duplicate.receipt, status: "duplicate" };
		}
		if (capability.revoked || (capability.kind === "registration" && capability.consumed)) {
			throw new WakeClientError("WAKE_REVOKED", "Wake capability has been revoked or consumed");
		}
		const binding = this.requireOwnedSession(capability.session);
		if (!binding.liveSession && !this.createSession) {
			throw new WakeClientError("WAKE_OFFLINE", "Wake target session is not live");
		}
		const queue = this.queue(capability.session.id);
		if (queue.pending >= this.maxPendingPerSession) {
			throw new WakeClientError("WAKE_BUSY", "Wake queue is full", { retryAfterMs: DEFAULT_RETRY_AFTER_MS });
		}
		queue.pending++;
		const requestId = `wake_req_${randomUUID().replaceAll("-", "")}`;
		const receipt: WakeReceipt = { status: "accepted", requestId };
		this.dedupe.set(dedupeKey, { receipt });
		if (this.dedupe.size > MAX_DEDUPE_ENTRIES) this.dedupe.delete(this.dedupe.keys().next().value!);
		capability.consumed = capability.kind === "registration";
		const registration = capability.registrationId ? this.registrations.get(capability.registrationId) : undefined;
		if (registration) {
			registration.info.status = "accepted";
			registration.info.updatedAt = new Date().toISOString();
			if (registration.timer) clearTimeout(registration.timer);
		}
		const envelope: WakeEnvelope = {
			schemaVersion: 1,
			resourceId: capability.id,
			requestId,
			receivedAt: new Date().toISOString(),
			target: { kind: "pi_session", sessionId: capability.session.id },
			source,
			event,
			registration: registration
				? {
						id: registration.info.id,
						reason: registration.info.reason,
						objective: registration.info.objective,
						checkFirst: registration.info.checkFirst,
					}
				: undefined,
		};
		try {
			await this.journal.append({
				kind: "accepted",
				resourceId: capability.id,
				requestId,
				source: source as never,
				target: capability.session as never,
				data: { eventId: event.eventId } as never,
			});
			this.enqueue(capability.session, envelope, registration);
			return receipt;
		} catch (error) {
			queue.pending--;
			this.dedupe.delete(dedupeKey);
			capability.consumed = false;
			if (registration) registration.info.status = "armed";
			throw error;
		}
	}

	private enqueue(
		session: WakeSessionReference,
		envelope: WakeEnvelope,
		registration: RegistrationState | undefined,
	): void {
		const queue = this.queue(session.id);
		const task = queue.tail.then(() => this.runExclusive(session.file, () => this.dispatch(session, envelope)));
		queue.tail = task
			.then(async (outcome) => {
				this.finishRegistration(registration, outcome);
			})
			.catch(async (error) => {
				const classified = classifyError(error);
				this.finishRegistration(registration, {
					requestId: envelope.requestId,
					status: classified.retriable ? "retryable" : "blocked",
					error: classified,
				});
			})
			.finally(() => {
				queue.pending--;
			});
	}

	private finishRegistration(registration: RegistrationState | undefined, outcome: WakeOutcome): void {
		if (!registration) return;
		registration.info.status = outcome.status === "completed" ? "completed" : "failed";
		registration.info.updatedAt = new Date().toISOString();
		registration.abortController.abort(`Wake registration ${outcome.status}`);
		registration.outcome.resolve(outcome);
	}

	private async dispatch(sessionRef: WakeSessionReference, envelope: WakeEnvelope): Promise<WakeOutcome> {
		let session: AgentSession | undefined;
		let temporary = false;
		try {
			await this.journal.append({
				kind: "dispatching",
				resourceId: envelope.resourceId,
				requestId: envelope.requestId,
				source: envelope.source as never,
				target: sessionRef as never,
			});
			const binding = this.requireOwnedSession(sessionRef);
			session = binding.liveSession;
			if (!session) {
				if (!this.createSession) throw new WakeClientError("WAKE_OFFLINE", "Wake target session is not live");
				await this.validateSessionReference(sessionRef);
				session = await this.createSession(sessionRef.file, sessionRef.cwd);
				temporary = true;
			}
			await session.waitForIdle();
			const prompt = composeWakeEventPrompt(envelope);
			await session.sendCustomMessage(
				{
					customType: "wake_event",
					content: [{ type: "text", text: prompt }],
					display: false,
					details: envelope,
				},
				{ triggerTurn: true, preflight: true },
			);
			const outcome: WakeOutcome = { requestId: envelope.requestId, status: "completed" };
			await this.journal.append({
				kind: "completed",
				resourceId: envelope.resourceId,
				requestId: envelope.requestId,
				target: sessionRef as never,
			});
			return outcome;
		} catch (error) {
			const classified = classifyError(error);
			const outcome: WakeOutcome = {
				requestId: envelope.requestId,
				status: classified.retriable ? "retryable" : "blocked",
				error: classified,
			};
			await this.journal.append({
				kind: outcome.status,
				resourceId: envelope.resourceId,
				requestId: envelope.requestId,
				target: sessionRef as never,
				error: classified as never,
			});
			return outcome;
		} finally {
			if (temporary && session) {
				const binding = this.bindingsById.get(sessionRef.id);
				if (binding?.liveSession === session) binding.liveSession = undefined;
				session.dispose();
			}
		}
	}

	private async validateSessionReference(ref: WakeSessionReference): Promise<void> {
		const manager = SessionManager.open(ref.file, undefined, ref.cwd);
		const header = manager.getHeader();
		if (!header || header.id !== ref.id) throw new Error("Session header ID does not match Wake target");
		if (resolve(header.cwd) !== resolve(ref.cwd)) throw new Error("Session cwd does not match Wake target");
	}

	private queue(sessionId: string): QueueState {
		let queue = this.queues.get(sessionId);
		if (!queue) {
			queue = { pending: 0, tail: Promise.resolve() };
			this.queues.set(sessionId, queue);
		}
		return queue;
	}

	private mutex(sessionFile: string): SessionMutex {
		let mutex = this.mutexes.get(sessionFile);
		if (!mutex) {
			mutex = new SessionMutex();
			this.mutexes.set(sessionFile, mutex);
		}
		return mutex;
	}

	private matchesToken(capability: CapabilityState, token: string): boolean {
		const expected = Buffer.from(capability.tokenHash, "hex");
		const actual = Buffer.from(hashCapabilityToken(token), "hex");
		return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
	}

	private async acquireOwnership(ref: WakeSessionReference): Promise<() => Promise<void>> {
		const directory = join(this.agentDir, "run", "wake", "owners");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(resolve(ref.file)).digest("hex");
		const ownerFile = join(directory, `${hash}.owner`);
		await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, sessionId: ref.id })}\n`, {
			flag: "a",
			mode: 0o600,
		});
		const release = await lockfile.lock(ownerFile, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
		return async () => release();
	}

	private async startServer(): Promise<void> {
		const runtimeId = randomUUID().replaceAll("-", "");
		const directory = join(this.agentDir, "run", "wake");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const endpoint =
			process.platform === "win32"
				? `\\\\.\\pipe\\pi-wake-${process.pid}-${runtimeId}`
				: join(directory, `${process.pid}-${runtimeId}.sock`);
		const server = createServer((socket) => this.acceptSocket(socket));
		await new Promise<void>((resolveListen, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolveListen();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(endpoint);
		});
		if (process.platform !== "win32") await chmod(endpoint, 0o600);
		this.server = server;
		this.endpoint = endpoint;
	}

	private acceptSocket(socket: Socket): void {
		const decoder = new WakeFrameDecoder();
		let handled = false;
		const respond = (response: WakeWireResponse): void => {
			if (socket.destroyed) return;
			socket.end(encodeWakeFrame(response));
		};
		socket.on("data", (chunk) => {
			if (handled) return;
			try {
				const values = decoder.push(chunk);
				if (values.length === 0) return;
				handled = true;
				const request = values[0] as WakeWireRequest;
				void this.acceptWireRequest(request).then(
					(receipt) => respond({ version: WAKE_WIRE_VERSION, ok: true, receipt }),
					(error) => {
						const wakeError =
							error instanceof WakeClientError
								? error
								: new WakeClientError("WAKE_INTERNAL", "Wake request failed", { cause: error });
						respond({
							version: WAKE_WIRE_VERSION,
							ok: false,
							error: {
								code: wakeError.code,
								message: wakeError.message,
								retryAfterMs: wakeError.retryAfterMs,
							},
						});
					},
				);
			} catch {
				handled = true;
				respond({
					version: WAKE_WIRE_VERSION,
					ok: false,
					error: { code: "WAKE_INVALID_EVENT", message: "Wake IPC request is invalid" },
				});
			}
		});
		socket.once("error", () => socket.destroy());
	}

	private async closeServer(): Promise<void> {
		const server = this.server;
		const endpoint = this.endpoint;
		this.server = undefined;
		this.endpoint = undefined;
		if (server?.listening) {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
		if (endpoint && process.platform !== "win32") {
			await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
