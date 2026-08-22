import { resolve } from "node:path";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { WakeRuntime } from "../../src/core/wake/runtime.ts";

const agentDir = resolve(process.argv[2]!);
const sessionFile = resolve(process.argv[3]!);
const sessionId = process.argv[4]!;

const session = {
	sessionFile,
	sessionManager: {
		getSessionId: () => sessionId,
		getSessionFile: () => sessionFile,
		getCwd: () => agentDir,
	},
	isStreaming: false,
	waitForIdle: async () => undefined,
	sendCustomMessage: async (message: { details?: unknown }) => {
		process.stdout.write(`${JSON.stringify({ type: "event", details: message.details })}\n`);
	},
	dispose: () => undefined,
} as unknown as AgentSession;

const runtime = new WakeRuntime({ agentDir });
const binding = await runtime.bindSession(session);
if (!binding.owned) throw binding.error;
const inbox = await binding.context.openInbox();
process.stdout.write(`${JSON.stringify({ type: "ready", address: inbox.address })}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (value) => {
	if (!value.includes("stop")) return;
	void runtime.stop().finally(() => process.exit(0));
});
process.stdin.resume();
