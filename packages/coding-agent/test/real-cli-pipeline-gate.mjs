#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../dist/modes/rpc/rpc-client.js";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const packageRoot = resolve(scriptDir, "..");
const defaultBinary = join(packageRoot, "dist", process.platform === "win32" ? "pi.exe" : "pi");
const binary = resolve(process.argv[2] ?? defaultBinary);
const outputRoot = resolve(process.argv[3] ?? join(packageRoot, ".artifacts", "real-cli-pipeline-gate"));
const runCount = Number.parseInt(process.argv[4] ?? "3", 10);
const timeoutMs = Number.parseInt(process.env.AUTOPI_PIPELINE_GATE_TIMEOUT_MS ?? "900000", 10);
const provider = process.env.AUTOPI_PIPELINE_GATE_PROVIDER;
const model = process.env.AUTOPI_PIPELINE_GATE_MODEL;
const thinking = process.env.AUTOPI_PIPELINE_GATE_THINKING ?? "high";
const pollMs = 1000;
const stableMs = 5000;

if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount > 10) {
	throw new Error("run count must be an integer from 1 to 10");
}
if (!["off", "minimal", "low", "medium", "high", "max"].includes(thinking)) {
	throw new Error(`unsupported thinking level: ${thinking}`);
}

const terminalAutomationStatuses = new Set([
	"blocked",
	"cancelled",
	"completed",
	"dead_letter",
	"expired",
	"failed",
	"succeeded",
]);
const expectedFiles = [
	"pipeline/evidence/train-v1.json",
	"pipeline/evidence/test-v1.json",
	"pipeline/evidence/report-v1.json",
	"pipeline/evidence/analysis.json",
	"pipeline/evidence/improvement.json",
	"pipeline/evidence/train-v2.json",
	"pipeline/evidence/test-v2.json",
	"pipeline/evidence/final-report.json",
	"pipeline/site/index.html",
];
const evidenceNames = [
	"train-v1",
	"test-v1",
	"report-v1",
	"analysis",
	"improvement",
	"train-v2",
	"test-v2",
	"final-report",
];

const prompt =
	"请在当前空目录内全程无人干预并严格按编号顺序完成纯本地轻量 CV 训练模拟流水线，进入下一步后不得回写或重跑前一步且总共只训练 v1、v2 两次：①只用 Node.js 与通用 shell，Node 脚本必须为 .cjs 或合法 ESM，全部内容只能位于 pipeline/；②用 background_task 异步连续训练 v1 至少 45 秒；③用首次采样即返回 wake 的 outer_loop.wait_custom QuickJS 脚本（pollInterval 00:00:30、timeout 至少 00:01:00、onTimeout 为 wake）在 v1 尚未结束时自报一次虚假 wake；④醒来后严格按 checkFirst 用 background_task get/status 复查运行状态、退出码、日志、模型文件，确认仍未结束且绝不把提前 wake 当成功；⑤用带 timeout 的 wait_task 等到 v1 真实终态；⑥确认 v1 exitCode 为 0 后测试并依次生成 pipeline/evidence/train-v1.json、test-v1.json、report-v1.json，任何解析或执行错误都必须非零退出并写 failed，禁止捕获错误后仍写 passed，确认三者已存在且无 error/exception 再进入分析；⑦生成 pipeline/evidence/analysis.json 后改进 pipeline 并生成 pipeline/evidence/improvement.json；⑧仅一次用 background_task 异步训练 v2 并用带 timeout 的 wait_task 等到真实终态；⑨确认 v2 exitCode 为 0 后按同一真实性规则测试并生成 pipeline/evidence/train-v2.json、test-v2.json；⑩只依据实际退出码、日志时间戳和文件 SHA-256 生成 pipeline/evidence/final-report.json，所有上述 JSON 均使用项目相对路径并含 startedAt、finishedAt、exitCode、status、相关 artifactSha256 及可校验的相对 artifact 路径，不得嵌入绝对路径或含绝对路径的原始日志行，最终报告须引用实际训练和测试证据中的 hash；⑪生成无第三方依赖的常见 LLM 编程评测仪表盘 pipeline/site/index.html；⑫启动本地网站逐一 HTTP 检查首页和证据 JSON，随后停止服务器且不留下常驻进程。";

function sleep(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function snapshotFiles(root) {
	const files = [];
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const contents = await readFile(path);
			const metadata = await stat(path);
			files.push({
				path: relative(root, path).replaceAll("\\", "/"),
				size: metadata.size,
				mtime: metadata.mtime.toISOString(),
				sha256: createHash("sha256").update(contents).digest("hex"),
			});
		}
	}
	await walk(root);
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readJsonIfPresent(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		return { __parseError: error instanceof Error ? error.message : String(error) };
	}
}

function isValidTimestamp(value) {
	return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function collectStrings(value, strings = []) {
	if (typeof value === "string") strings.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, strings);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, strings);
	return strings;
}

function collectFailureSignals(value, path = "$", signals = []) {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) collectFailureSignals(value[index], `${path}[${index}]`, signals);
		return signals;
	}
	if (!value || typeof value !== "object") return signals;
	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}.${key}`;
		if (/^(?:error|errors|exception|exceptions)$/i.test(key)) {
			const populated =
				(typeof entry === "string" && entry.trim().length > 0) ||
				(Array.isArray(entry) && entry.length > 0) ||
				(entry && typeof entry === "object" && Object.keys(entry).length > 0) ||
				(typeof entry !== "string" && !Array.isArray(entry) && typeof entry !== "object" && Boolean(entry));
			if (populated) signals.push({ path: entryPath, value: entry });
		}
		collectFailureSignals(entry, entryPath, signals);
	}
	return signals;
}

function collectSha256Strings(value) {
	return collectStrings(value).filter((entry) => /^[a-f0-9]{64}$/i.test(entry));
}

function messageText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((item) => item?.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function findSameBatchWaitEscapes(messages) {
	const results = new Map();
	for (const message of messages) {
		if (message?.role !== "toolResult") continue;
		results.set(message.toolCallId, message);
	}
	const escapes = [];
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const calls = message.content.filter((item) => item?.type === "toolCall");
		const waitIndex = calls.findIndex(
			(call) =>
				call.name === "outer_loop" &&
				typeof call.arguments?.action === "string" &&
				call.arguments.action.startsWith("wait_"),
		);
		if (waitIndex < 0) continue;
		for (const call of calls.slice(waitIndex + 1)) {
			const result = results.get(call.id);
			if (!messageText(result).includes("Tool execution deferred because outer_loop established a stage boundary")) {
				escapes.push({ toolCallId: call.id, toolName: call.name, arguments: call.arguments, result });
			}
		}
	}
	return escapes;
}

async function validateArtifactHash(root, evidence) {
	if (!evidence || typeof evidence !== "object") return false;
	if (evidence.artifactSha256 && typeof evidence.artifactSha256 === "object") {
		const entries = Object.entries(evidence.artifactSha256);
		if (entries.length === 0) return false;
		return (
			await Promise.all(
				entries.map(async ([artifactPath, expectedHash]) => {
					if (typeof expectedHash !== "string") return false;
					const artifact = resolve(root, artifactPath);
					if (relative(root, artifact).startsWith("..") || !(await exists(artifact))) return false;
					const contents = await readFile(artifact);
					return createHash("sha256").update(contents).digest("hex") === expectedHash;
				}),
			)
		).every(Boolean);
	}
	const artifactPath = evidence.artifactPath ?? evidence.modelPath ?? evidence.artifact;
	if (typeof artifactPath !== "string" || typeof evidence.artifactSha256 !== "string") return false;
	const artifact = resolve(root, artifactPath);
	if (relative(root, artifact).startsWith("..") || !(await exists(artifact))) return false;
	const contents = await readFile(artifact);
	return createHash("sha256").update(contents).digest("hex") === evidence.artifactSha256;
}

function toolTimeline(records) {
	return records
		.filter((record) => record.channel === "agent" && record.event?.type?.startsWith("tool_execution_"))
		.map((record) => ({
			at: record.at,
			type: record.event.type,
			toolCallId: record.event.toolCallId,
			toolName: record.event.toolName,
			isError: record.event.isError,
			args: record.event.args,
		}));
}

async function executeRun(index) {
	const runRoot = join(outputRoot, `run-${String(index).padStart(2, "0")}`);
	await mkdir(runRoot, { recursive: true });
	const records = [];
	let lastEventAt = Date.now();
	let promptSubmitted = false;
	let sawAgentActivity = false;
	let terminalAgentError = false;
	const client = new RpcClient({
		executablePath: binary,
		cwd: runRoot,
		provider,
		model,
		args: ["--approve", "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--thinking", thinking],
		startupTimeoutMs: 60_000,
	});
	client.onEvent((event) => {
		lastEventAt = Date.now();
		if (promptSubmitted) sawAgentActivity = true;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			terminalAgentError = event.message.stopReason === "error";
		}
		records.push({ at: new Date().toISOString(), channel: "agent", event });
	});
	client.onProtocolEvent((event) => {
		lastEventAt = Date.now();
		records.push({ at: new Date().toISOString(), channel: "protocol", event });
	});
	const startedAt = new Date().toISOString();
	let completionReason = "unknown";
	let latestState;
	let latestAutomations = [];
	let latestMessages = [];
	try {
		await client.start();
		promptSubmitted = true;
		await client.prompt(prompt);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await sleep(pollMs);
			latestState = await client.getState();
			latestAutomations = await client.listAutomations(true);
			const active = latestAutomations.filter((automation) => !terminalAutomationStatuses.has(automation.status));
			if (
				sawAgentActivity &&
				latestState.isStreaming === false &&
				active.length === 0 &&
				Date.now() - lastEventAt >= stableMs
			) {
				completionReason = terminalAgentError ? "terminal_agent_error" : "settled_without_active_automations";
				break;
			}
		}
		if (completionReason === "unknown") completionReason = "timeout";
	} catch (error) {
		completionReason = "client_error";
		records.push({
			at: new Date().toISOString(),
			channel: "harness",
			event: { type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) },
		});
	} finally {
		[latestState, latestAutomations, latestMessages] = await Promise.all([
			client.getState().catch(() => latestState),
			client.listAutomations(true).catch(() => latestAutomations),
			client.getMessages().catch(() => latestMessages),
		]);
		await client.stop().catch(() => undefined);
	}
	const finishedAt = new Date().toISOString();
	const files = await snapshotFiles(runRoot);
	const missingFiles = expectedFiles.filter((path) => !files.some((file) => file.path === path));
	const evidenceReports = Object.fromEntries(
		await Promise.all(
			evidenceNames.map(async (name) => [name, await readJsonIfPresent(join(runRoot, "pipeline", "evidence", `${name}.json`))]),
		),
	);
	const finalReport = evidenceReports["final-report"];
	const timeline = toolTimeline(records);
	const backgroundStarts = timeline.filter(
		(item) => item.type === "tool_execution_start" && item.toolName === "background_task",
	).length;
	const customWaits = timeline.filter(
		(item) =>
			item.type === "tool_execution_start" &&
			item.toolName === "outer_loop" &&
			item.args?.action === "wait_custom",
	).length;
	const taskWaits = timeline.filter(
		(item) =>
			item.type === "tool_execution_start" && item.toolName === "outer_loop" && item.args?.action === "wait_task",
	).length;
	const absolutePathLeaks = files.filter((file) => /^[A-Za-z]:\//.test(file.path) || file.path.startsWith("/"));
	const modelFilesOutsidePipeline = files.filter((file) => !file.path.startsWith("pipeline/"));
	const evidencePathLeaks = collectStrings(evidenceReports).filter(
		(value) => /[A-Za-z]:[\\/]/.test(value) || /\/(?:home|tmp|Users|var)\//.test(value),
	);
	const metadataValid = evidenceNames.every((name) => {
		const report = evidenceReports[name];
		const requiresExitCode = /^(?:train|test)-/.test(name);
		return (
			report &&
			typeof report === "object" &&
			!("__parseError" in report) &&
			isValidTimestamp(report.startedAt) &&
			isValidTimestamp(report.finishedAt) &&
			new Date(report.startedAt).getTime() <= new Date(report.finishedAt).getTime() &&
			(requiresExitCode ? Number.isInteger(report.exitCode) : report.exitCode === undefined || Number.isInteger(report.exitCode)) &&
			typeof report.status === "string"
		);
	});
	const evidenceFileMetadata = new Map(
		files
			.filter((file) => file.path.startsWith("pipeline/evidence/") && file.path.endsWith(".json"))
			.map((file) => [basename(file.path, ".json"), file]),
	);
	const timestamp = (value) => new Date(value).getTime();
	const mtime = (name) => timestamp(evidenceFileMetadata.get(name)?.mtime);
	const timelineValid =
		metadataValid &&
		timestamp(evidenceReports["train-v1"].finishedAt) <= timestamp(evidenceReports["test-v1"].startedAt) &&
		timestamp(evidenceReports["test-v1"].finishedAt) <= mtime("report-v1") &&
		mtime("report-v1") <= mtime("analysis") &&
		mtime("analysis") <= mtime("improvement") &&
		mtime("improvement") <= timestamp(evidenceReports["train-v2"].startedAt) &&
		timestamp(evidenceReports["train-v2"].finishedAt) <= timestamp(evidenceReports["test-v2"].startedAt) &&
		timestamp(evidenceReports["test-v2"].finishedAt) <= mtime("final-report");
	const evidenceFailureSignals = evidenceNames.flatMap((name) =>
		collectFailureSignals(evidenceReports[name], `$.${name}`),
	);
	const artifactHashesValid = (
		await Promise.all(
			["train-v1", "test-v1", "train-v2", "test-v2"].map((name) => validateArtifactHash(runRoot, evidenceReports[name])),
		)
	).every(Boolean);
	const backgroundAutomations = latestAutomations
		.filter((automation) => automation.kind === "background_task")
		.sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));
	const wakeAutomations = latestAutomations.filter((automation) => automation.kind === "wake");
	const waitedTaskIds = new Set(
		wakeAutomations
			.filter(
				(automation) =>
					automation.wake.trigger.type === "monitor" &&
					automation.wake.trigger.adapter === "background_task_state",
			)
			.map((automation) => automation.wake.trigger.source?.taskId)
			.filter((taskId) => typeof taskId === "string"),
	);
	const trainingAutomations = backgroundAutomations.filter((automation) => waitedTaskIds.has(automation.task.id));
	const firstTask = backgroundAutomations[0]?.task;
	const customWake = wakeAutomations.find(
		(automation) =>
			automation.wake.trigger.type === "monitor" && automation.wake.trigger.adapter === "custom_monitor",
	)?.wake;
	const customWakeAt = customWake?.triggerRuntime?.satisfiedAt;
	const falseWakePrecededTaskTerminal = Boolean(
		firstTask &&
			customWakeAt &&
			firstTask.endedAt &&
			new Date(firstTask.createdAt).getTime() < new Date(customWakeAt).getTime() &&
			new Date(customWakeAt).getTime() < new Date(firstTask.endedAt).getTime() &&
			customWake.triggerRuntime?.cause === "monitor_match" &&
			customWake.triggerRuntime?.evidence?.fields?.wakeEvent,
	);
	const firstTaskDurationMs = firstTask?.endedAt
		? new Date(firstTask.endedAt).getTime() - new Date(firstTask.createdAt).getTime()
		: 0;
	const wakeMessageIndex = latestMessages.findIndex(
		(message) =>
			message?.role === "custom" &&
			message.customType === "wake_event" &&
			message.details?.event?.data?.wakeId === customWake?.id,
	);
	const recheckedAfterFalseWake =
		wakeMessageIndex >= 0 &&
		latestMessages.slice(wakeMessageIndex + 1).some(
			(message) =>
				message?.role === "assistant" &&
				message.content?.some(
					(item) =>
						item?.type === "toolCall" &&
						item.name === "background_task" &&
						(item.arguments?.action === "get" || item.arguments?.action === "status") &&
						item.arguments?.taskId === firstTask?.id,
				),
		);
	const taskWaitCoveredFirstTask = wakeAutomations.some(
		(automation) =>
			automation.wake.trigger.type === "monitor" &&
			automation.wake.trigger.adapter === "background_task_state" &&
			automation.wake.trigger.source?.taskId === firstTask?.id,
	);
	const assistantErrors = latestMessages.filter(
		(message) => message?.role === "assistant" && message.stopReason === "error",
	);
	const sameBatchWaitEscapes = findSameBatchWaitEscapes(latestMessages);
	const exitCodesValid =
		metadataValid &&
		["train-v1", "test-v1", "train-v2", "test-v2"].every((name) => evidenceReports[name].exitCode === 0) &&
		trainingAutomations.length >= 2 &&
		trainingAutomations.every(
			(automation) => automation.task.status === "succeeded" && automation.task.exitCode === 0,
		);
	const finalReportPayload = JSON.stringify(finalReport);
	const finalReportTruthful =
		finalReport &&
		(finalReport.exitCode === undefined || finalReport.exitCode === 0) &&
		collectFailureSignals(finalReport, "$.final-report").length === 0 &&
		["train-v1", "test-v1", "train-v2", "test-v2"].every((name) => {
			const source = evidenceReports[name];
			const hashes = collectSha256Strings(source);
			const sourceFileHash = evidenceFileMetadata.get(name)?.sha256;
			return (
				source?.exitCode === 0 &&
				((hashes.length > 0 && hashes.every((hash) => finalReportPayload.includes(hash))) ||
					(typeof sourceFileHash === "string" && finalReportPayload.includes(sourceFileHash)))
			);
		});
	const verdict = {
		completed: completionReason === "settled_without_active_automations",
		allExpectedFilesPresent: missingFiles.length === 0,
		usedBackgroundTasks: backgroundStarts >= 2 && trainingAutomations.length >= 2,
		usedCustomFalseWake: customWaits >= 1,
		usedTaskWaits: taskWaits >= 1,
		noActiveAutomations: latestAutomations.every((automation) => terminalAutomationStatuses.has(automation.status)),
		noAbsoluteArtifactPaths: absolutePathLeaks.length === 0 && evidencePathLeaks.length === 0,
		allModelArtifactsUnderPipeline: modelFilesOutsidePipeline.length === 0,
		evidenceMetadataValid: metadataValid,
		evidenceTimelineValid: timelineValid,
		noEvidenceFailureSignals: evidenceFailureSignals.length === 0,
		artifactHashesValid,
		exitCodesValid,
		finalReportTruthful,
		firstTrainingRanAtLeastEightSeconds: firstTaskDurationMs >= 8_000,
		falseWakePrecededTaskTerminal,
		recheckedAfterFalseWake,
		taskWaitCoveredFirstTask,
		noAssistantErrors: assistantErrors.length === 0,
		noSameBatchWaitEscape: sameBatchWaitEscapes.length === 0,
	};
	const passed = Object.values(verdict).every(Boolean);
	const evidence = {
		run: index,
		binary: { path: binary, name: basename(binary) },
		model: { provider: provider ?? null, id: model ?? null, thinking },
		startedAt,
		finishedAt,
		completionReason,
		prompt,
		verdict,
		passed,
		missingFiles,
		independentValidation: {
			firstTaskDurationMs,
			customWakeAt: customWakeAt ?? null,
			firstTaskEndedAt: firstTask?.endedAt ?? null,
			evidencePathLeaks,
			modelFilesOutsidePipeline,
			assistantErrors,
			evidenceFailureSignals,
			sameBatchWaitEscapes,
		},
		state: latestState,
		automations: latestAutomations,
		messages: latestMessages,
		files,
		evidenceReports,
		finalReport,
		toolTimeline: timeline,
		recordCount: records.length,
	};
	await writeFile(join(runRoot, "rpc-events.jsonl"), records.map(jsonLine).join(""), "utf8");
	await writeFile(join(runRoot, "gate-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	return evidence;
}

if (!isAbsolute(binary) || !(await exists(binary))) throw new Error(`CLI binary not found: ${binary}`);
await mkdir(outputRoot, { recursive: true });
const runs = [];
for (let index = 1; index <= runCount; index++) runs.push(await executeRun(index));
const report = {
	generatedAt: new Date().toISOString(),
	binary,
	model: { provider: provider ?? null, id: model ?? null, thinking },
	outputRoot,
	runCount,
	passed: runs.every((run) => run.passed),
	runs: runs.map((run) => ({
		run: run.run,
		passed: run.passed,
		completionReason: run.completionReason,
		verdict: run.verdict,
		missingFiles: run.missingFiles,
	})),
};
await writeFile(join(outputRoot, "gate-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
