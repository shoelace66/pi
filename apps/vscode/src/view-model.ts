import { access } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcAutomation } from "../../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import type { UiArtifact, UiAutomation, UiMessage } from "../shared/protocol.ts";

const activeWakeStatuses = new Set(["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"]);
const activeTaskStatuses = new Set(["running", "cancelling"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function messageText(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			if ((block.type === "text" || block.type === "thinking") && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function messageRole(message: AgentMessage): UiMessage["role"] {
	const role = (message as unknown as { role?: unknown }).role;
	return role === "user" || role === "assistant" ? role : "system";
}

function isInsideWorkspace(candidate: string, workspacePath: string): boolean {
	const relative = path.relative(workspacePath, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function existingArtifact(rawPath: string, workspacePath: string): Promise<UiArtifact | undefined> {
	const cleaned = rawPath.trim().replace(/^['"]|['"].*$/g, "");
	if (!cleaned || cleaned.includes("\n") || cleaned.length > 260) return undefined;
	const absolute = path.resolve(workspacePath, cleaned);
	if (!isInsideWorkspace(absolute, workspacePath)) return undefined;
	try {
		await access(absolute);
		return { label: path.relative(workspacePath, absolute), path: absolute };
	} catch {
		return undefined;
	}
}

export async function extractArtifacts(text: string, workspacePath: string): Promise<UiArtifact[]> {
	const candidates = new Set<string>();
	for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
		if (match[1]) candidates.add(match[1]);
	}
	for (const match of text.matchAll(/(?:^|[\s(])((?:\.?\.?[\\/])?[\w .@()-]+(?:[\\/][\w .@()-]+)*\.(?:md|html|json|csv|tsv|png|jpe?g|svg|pdf|txt|log))(?:$|[\s),])/gim)) {
		if (match[1]) candidates.add(match[1]);
	}
	const artifacts = await Promise.all([...candidates].map((candidate) => existingArtifact(candidate, workspacePath)));
	return artifacts.filter((artifact): artifact is UiArtifact => artifact !== undefined).slice(0, 12);
}

export async function toUiMessages(messages: AgentMessage[], workspacePath: string): Promise<UiMessage[]> {
	return Promise.all(
		messages.map(async (message, index) => {
			const text = messageText(message);
			return {
				id: `${index}-${messageRole(message)}`,
				role: messageRole(message),
				text,
				artifacts: await extractArtifacts(text, workspacePath),
			};
		}),
	);
}

export function toUiAutomations(automations: RpcAutomation[]): UiAutomation[] {
	return automations.map((automation) => {
		if (automation.kind === "background_task") {
			const task = automation.task;
			const exit = task.exitCode === undefined ? "" : ` · exit ${task.exitCode}`;
			return {
				id: task.id,
				kind: "background_task",
				title: task.command,
				detail: `PID ${task.pid} · ${task.cwd}${exit}`,
				status: task.status,
				logPath: task.logPath,
				canCancel: activeTaskStatuses.has(task.status),
			};
		}
		const wake = automation.wake;
		const runtime = wake.triggerRuntime;
		const error = runtime?.monitorError ?? wake.lastError;
		const diagnostics =
			wake.trigger.type === "monitor"
				? [
						`monitor ${wake.trigger.adapter}`,
						runtime ? `checks ${runtime.checkCount}` : undefined,
						runtime?.cause ? `cause ${runtime.cause}` : undefined,
						error ? `${error.code}: ${error.message}` : undefined,
					].filter((part): part is string => part !== undefined)
				: [`time ${wake.trigger.dueAt}`];
		return {
			id: wake.id,
			kind: "wake",
			title: wake.objective,
			detail: `${wake.reason} · ${diagnostics.join(" · ")}`,
			status: wake.status,
			canCancel: activeWakeStatuses.has(wake.status),
		};
	});
}
