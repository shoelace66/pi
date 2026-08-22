import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryWakeStore } from "../../../packages/coding-agent/src/core/outer-loop/in-memory-wake-store.ts";
import { DesktopWakeService } from "../electron/services/desktop-wake-service.ts";

test("queues, delivers, and cancels desktop automation input", async () => {
	const store = new InMemoryWakeStore();
	const created = await store.createOnce({
		requestKey: "desktop-test",
		session: { id: "session-1", file: resolve("session.jsonl"), cwd: process.cwd() },
		reason: "Continue later",
		objective: "Resume the task",
		checkFirst: ["Check status"],
		trigger: { type: "time", dueAt: new Date(Date.now() + 60_000).toISOString() },
	});
	const service = new DesktopWakeService(store);
	const message = await service.queueInput({
		sessionId: "session-1",
		wakeId: created.job.id,
		clientMessageId: "client-1",
		content: "Also run the focused tests",
	});

	assert.equal(message.status, "pending");
	assert.equal((await service.list("session-1"))[0]?.pendingInboxCount, 1);
	service.markDelivering(created.job.id);
	assert.equal(service.getInbox(created.job.id)[0]?.status, "delivering");
	service.markDelivered(created.job.id);
	assert.equal(service.getInbox(created.job.id)[0]?.status, "delivered");

	const cancelled = await service.cancel("session-1", created.job.id);
	assert.equal(cancelled.status, "cancelled");
});
