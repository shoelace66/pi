import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { WakeClient } from "../src/core/wake/client.ts";
import { InMemoryWakeJournal } from "../src/core/wake/journal.ts";
import { WakeRuntime } from "../src/core/wake/runtime.ts";
import type { WakeEnvelope } from "../src/core/wake/types.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

type FakeSession = {
	session: AgentSession;
	messages: WakeEnvelope[];
};

function fakeSession(
	directory: string,
	id: string,
	onMessage?: (envelope: WakeEnvelope) => Promise<void>,
	agentResult: { stopReason: "stop" | "error"; errorMessage?: string } = { stopReason: "stop" },
): FakeSession {
	const file = join(directory, `${id}.jsonl`);
	const messages: WakeEnvelope[] = [];
	const agentMessages: Array<Record<string, unknown>> = [];
	const session = {
		sessionFile: file,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getCwd: () => directory,
		},
		isStreaming: false,
		messages: agentMessages,
		waitForIdle: async () => undefined,
		sendCustomMessage: async (message: { customType: string; details?: unknown }) => {
			expect(message.customType).toBe("wake_event");
			const envelope = message.details as WakeEnvelope;
			messages.push(envelope);
			await onMessage?.(envelope);
			agentMessages.push({
				role: "assistant",
				content: [],
				stopReason: agentResult.stopReason,
				errorMessage: agentResult.errorMessage,
			});
		},
		dispose: () => undefined,
	} as unknown as AgentSession;
	return { session, messages };
}

const runtimes: WakeRuntime[] = [];
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const tsxCliPath = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const wakeRuntimeChildPath = fileURLToPath(new URL("./fixtures/wake-runtime-child.ts", import.meta.url));

async function makeTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-wake-runtime-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		await new Promise<void>((resolveExit) => {
			if (child.exitCode !== null) {
				resolveExit();
				return;
			}
			child.once("exit", () => resolveExit());
			child.stdin.once("error", () => undefined);
			if (child.stdin.writable) child.stdin.end("stop\n");
		});
	}
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WakeRuntime capabilities", () => {
	it("does not mark a wake completed when the resumed agent turn ends in an error", async () => {
		const directory = await makeTempDir();
		const target = fakeSession(directory, "agent-error", undefined, {
			stopReason: "error",
			errorMessage: "429 rate limit exceeded",
		});
		const journal = new InMemoryWakeJournal();
		const runtime = new WakeRuntime({ agentDir: directory, journal });
		runtimes.push(runtime);
		const binding = await runtime.bindSession(target.session);
		const registration = await binding.context.register({
			requestKey: "agent-error",
			producer: { id: "test-monitor" },
			reason: "resume after monitor",
			objective: "continue pipeline",
		});
		await registration.emit({ eventId: "agent-error", message: "resume" });
		await expect(registration.outcome).resolves.toMatchObject({
			status: "retryable",
			error: { code: "WAKE_AGENT_ERROR", retriable: true },
		});
		expect((await journal.read()).map((event) => event.kind)).toEqual(
			expect.arrayContaining(["accepted", "dispatching", "retryable"]),
		);
		expect((await journal.read()).map((event) => event.kind)).not.toContain("completed");
	});

	it("validates, consumes, deduplicates, revokes, expires, and journals capabilities", async () => {
		const directory = await makeTempDir();
		const releaseDispatch = deferred<void>();
		const target = fakeSession(directory, "capabilities", () => releaseDispatch.promise);
		const journal = new InMemoryWakeJournal();
		const runtime = new WakeRuntime({ agentDir: directory, journal });
		runtimes.push(runtime);
		const binding = await runtime.bindSession(target.session);
		expect(binding.owned).toBe(true);
		const context = binding.context;
		const registration = await context.register({
			requestKey: "capability-test",
			producer: { id: "test-monitor" },
			reason: "wait for test",
			objective: "continue test",
		});
		const address = await registration.createCapability();
		const client = new WakeClient();
		const tampered = `${address.slice(0, -1)}${address.endsWith("a") ? "b" : "a"}`;
		await expect(client.emit(tampered, { eventId: "bad", message: "bad token" })).rejects.toMatchObject({
			code: "WAKE_UNAUTHORIZED",
		});

		const first = await client.emit(address, { eventId: "event-1", message: "ready", data: { ok: true } });
		const duplicate = await client.emit(address, { eventId: "event-1", message: "ready", data: { ok: true } });
		expect(first.status).toBe("accepted");
		expect(duplicate).toEqual({ status: "duplicate", requestId: first.requestId });
		await expect(client.emit(address, { eventId: "event-2", message: "again" })).rejects.toMatchObject({
			code: "WAKE_REVOKED",
		});
		releaseDispatch.resolve();
		await expect(registration.outcome).resolves.toMatchObject({ status: "completed" });
		expect(registration.signal.aborted).toBe(true);
		expect(target.messages).toHaveLength(1);

		const inbox = await context.openInbox();
		expect(await inbox.revoke()).toBe(true);
		await expect(client.emit(inbox.address, { eventId: "revoked", message: "no" })).rejects.toMatchObject({
			code: "WAKE_REVOKED",
		});

		const expiring = await context.register({
			requestKey: "expires",
			producer: { id: "test-monitor" },
			reason: "expiration",
			objective: "do not run",
			expiresAt: new Date(Date.now() + 30).toISOString(),
		});
		await expiring.outcome;
		expect(expiring.signal.aborted).toBe(true);
		expect((await context.list()).find((item) => item.id === expiring.id)?.status).toBe("expired");

		await expect(client.emit(address, { eventId: "", message: "invalid" })).rejects.toMatchObject({
			code: "WAKE_INVALID_EVENT",
		});
		await expect(client.emit(address, { eventId: "too-large", message: "x".repeat(16_385) })).rejects.toMatchObject({
			code: "WAKE_INVALID_EVENT",
		});
		await expect(
			client.emit(address, { eventId: "large-data", message: "large", data: { value: "x".repeat(70_000) } }),
		).rejects.toMatchObject({ code: "WAKE_INVALID_EVENT" });
		await expect(
			client.emit(address, { eventId: "invalid-json", message: "invalid", data: Number.NaN as never }),
		).rejects.toMatchObject({ code: "WAKE_INVALID_EVENT" });
		const kinds = (await journal.read()).map((event) => event.kind);
		expect(kinds).toEqual(
			expect.arrayContaining(["accepted", "duplicate", "dispatching", "completed", "revoked", "rejected"]),
		);
	});

	it("enforces FIFO and capacity per session while allowing another session to run", async () => {
		const directory = await makeTempDir();
		const releaseFirst = deferred<void>();
		const secondDelivered = deferred<void>();
		const otherDelivered = deferred<void>();
		const order: string[] = [];
		const first = fakeSession(directory, "queue-a", async (envelope) => {
			order.push(envelope.event.eventId);
			if (envelope.event.eventId === "a-1") await releaseFirst.promise;
			else secondDelivered.resolve();
		});
		const second = fakeSession(directory, "queue-b", async (envelope) => {
			order.push(envelope.event.eventId);
			otherDelivered.resolve();
		});
		const runtime = new WakeRuntime({ agentDir: directory, maxPendingPerSession: 2 });
		runtimes.push(runtime);
		const firstBinding = await runtime.bindSession(first.session);
		const secondBinding = await runtime.bindSession(second.session);
		const firstInbox = await firstBinding.context.openInbox();
		const secondInbox = await secondBinding.context.openInbox();
		const client = new WakeClient();

		await expect(client.emit(firstInbox.address, { eventId: "a-1", message: "first" })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(client.emit(firstInbox.address, { eventId: "a-2", message: "second" })).resolves.toMatchObject({
			status: "accepted",
		});
		await expect(client.emit(firstInbox.address, { eventId: "a-3", message: "overflow" })).rejects.toMatchObject({
			code: "WAKE_BUSY",
			retryAfterMs: 1_000,
		});
		await client.emit(secondInbox.address, { eventId: "b-1", message: "parallel" });
		await otherDelivered.promise;
		expect(order).toEqual(["a-1", "b-1"]);
		releaseFirst.resolve();
		await secondDelivered.promise;
		expect(order).toEqual(["a-1", "b-1", "a-2"]);
	});

	it("keeps the first owner and terminates registrations on cancel, timeout, and shutdown", async () => {
		const directory = await makeTempDir();
		const target = fakeSession(directory, "owned");
		const first = new WakeRuntime({ agentDir: directory });
		const second = new WakeRuntime({ agentDir: directory });
		runtimes.push(first, second);
		expect((await first.bindSession(target.session)).owned).toBe(true);
		const competing = await second.bindSession(target.session);
		expect(competing.owned).toBe(false);
		await expect(
			competing.context.register({
				requestKey: "not-owner",
				producer: { id: "test" },
				reason: "ownership",
				objective: "fail clearly",
			}),
		).rejects.toMatchObject({ code: "WAKE_SESSION_OWNED" });

		const context = first.contextForSession(target.session)!;
		const cancelled = await context.register({
			requestKey: "cancelled",
			producer: { id: "test" },
			reason: "cancel",
			objective: "cancel",
		});
		expect(await cancelled.cancel()).toBe(true);
		await expect(cancelled.outcome).resolves.toMatchObject({ status: "cancelled" });
		const shutdown = await context.register({
			requestKey: "shutdown",
			producer: { id: "test" },
			reason: "shutdown",
			objective: "shutdown",
		});
		const inbox = await context.openInbox();
		first.unbindSession(target.session.sessionFile);
		await expect(
			new WakeClient().emit(inbox.address, { eventId: "offline", message: "offline" }),
		).rejects.toMatchObject({
			code: "WAKE_OFFLINE",
		});
		await first.stop();
		await expect(shutdown.outcome).resolves.toMatchObject({ status: "cancelled" });
		expect(shutdown.signal.aborted).toBe(true);
	});
});

describe("WakeRuntime local IPC", () => {
	it("delivers once between two runtimes in separate processes with structured agent source", async () => {
		const directory = await makeTempDir();
		const child = spawn(
			process.execPath,
			[
				tsxCliPath,
				wakeRuntimeChildPath,
				join(directory, "target-runtime"),
				join(directory, "target-session.jsonl"),
				"target-session",
			],
			{ stdio: "pipe" },
		);
		children.push(child);
		const lines = lineReader(child);
		const ready = (await lines.next()).value as { type: "ready"; address: string };
		expect(ready.type).toBe("ready");

		const sourceSession = fakeSession(directory, "source-session");
		const sourceRuntime = new WakeRuntime({ agentDir: join(directory, "source-runtime") });
		runtimes.push(sourceRuntime);
		const binding = await sourceRuntime.bindSession(sourceSession.session);
		const event = { eventId: "cross-process", message: "coordinate", data: { task: 7 } };
		const first = await binding.context.send(ready.address, event);
		const duplicate = await binding.context.send(ready.address, event);
		expect(first.status).toBe("accepted");
		expect(duplicate).toEqual({ status: "duplicate", requestId: first.requestId });
		const delivered = (await lines.next()).value as { type: "event"; details: WakeEnvelope };
		expect(delivered.details.event).toEqual(event);
		expect(delivered.details.source).toEqual({
			kind: "agent",
			sessionId: "source-session",
			verification: "self_reported",
		});
		child.stdin.write("stop\n");
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		await expect(
			binding.context.send(ready.address, { eventId: "offline", message: "offline" }),
		).rejects.toMatchObject({
			code: "WAKE_OFFLINE",
		});
	});
});

async function* lineReader(child: ChildProcessWithoutNullStreams): AsyncGenerator<unknown> {
	let buffer = "";
	for await (const chunk of child.stdout) {
		buffer += chunk.toString();
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) yield JSON.parse(line) as unknown;
		}
	}
}
