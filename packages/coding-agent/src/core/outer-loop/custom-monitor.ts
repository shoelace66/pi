import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import quickJSVariant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSSyncVariant,
	type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { BackgroundTaskManager } from "../background-task/manager.ts";
import type { ProcessStateAdapter } from "./adapters/process-state.ts";
import type { MonitorAdapter } from "./monitor-registry.ts";
import type { JsonValue, MonitorObservation } from "./types.ts";

const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_ACTION_BYTES = 256 * 1024;
const MAX_FILE_READ_BYTES = 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS_PER_SAMPLE = 16;
const SCRIPT_DEADLINE_MS = 250;
const SCRIPT_MEMORY_BYTES = 16 * 1024 * 1024;
const SCRIPT_STACK_BYTES = 512 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_HTTP_REDIRECTS = 5;

export type CustomMonitorPolicy = {
	enabled: boolean;
	projectTrusted: boolean;
	allowedOrigins: string[];
};

type RegisteredMonitor = {
	id: string;
	root: string;
	sessionId: string;
	scriptPath: string;
	scriptSha256: string;
	script: string;
	allowedOrigins: Set<string>;
	state: JsonValue;
	seenEventIds: Set<string>;
};

type MonitorRequest =
	| { kind: "file_stat"; path: string; includeHash?: boolean }
	| { kind: "file_read"; path: string; maxBytes?: number }
	| { kind: "task_status"; taskId: string }
	| { kind: "process_status"; pid: number }
	| { kind: "http"; url: string; method?: "GET" | "HEAD" };

type MonitorAction =
	| { type: "request"; request: MonitorRequest; state?: JsonValue }
	| { type: "continue"; message?: string; state?: JsonValue }
	| { type: "wake"; eventId: string; message: string; data?: JsonValue; state?: JsonValue };

let quickJSModulePromise: Promise<QuickJSWASMModule> | undefined;

function getQuickJSModule(): Promise<QuickJSWASMModule> {
	quickJSModulePromise ??= newQuickJSWASMModuleFromVariant(quickJSVariant as unknown as QuickJSSyncVariant);
	return quickJSModulePromise;
}

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isWithin(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CustomMonitorPolicyError("CUSTOM_MONITOR_INVALID_ORIGIN", `Invalid origin: ${value}`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
		throw new CustomMonitorPolicyError(
			"CUSTOM_MONITOR_INVALID_ORIGIN",
			`Custom monitor origins must use http or https: ${value}`,
		);
	}
	if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
		throw new CustomMonitorPolicyError(
			"CUSTOM_MONITOR_INVALID_ORIGIN",
			`Custom monitor allowlist entries must be origins without paths or credentials: ${value}`,
		);
	}
	return url.origin;
}

function monitorErrorDetails(error: unknown): { code: string; message: string } {
	if (error && typeof error === "object") {
		const code = "code" in error ? String((error as { code?: unknown }).code) : undefined;
		const message = "message" in error ? String((error as { message?: unknown }).message) : undefined;
		if (code && message) return { code, message };
	}
	return { code: "CUSTOM_MONITOR_FAILED", message: error instanceof Error ? error.message : String(error) };
}

export class CustomMonitorPolicyError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CustomMonitorPolicyError";
		this.code = code;
	}
}

export class CustomMonitorWakeError extends Error {
	readonly code: string;
	readonly wakeImmediately = true;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CustomMonitorWakeError";
		this.code = code;
	}
}

function validateState(value: unknown): JsonValue {
	if (value === undefined) return null;
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_INVALID_STATE",
			"Custom monitor state must be JSON-serializable",
		);
	}
	if (serialized === undefined) {
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_INVALID_STATE",
			"Custom monitor state must be JSON-serializable",
		);
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_STATE_LIMIT",
			`Custom monitor state exceeds ${MAX_STATE_BYTES} bytes`,
		);
	}
	return JSON.parse(serialized) as JsonValue;
}

function validateAction(value: unknown): MonitorAction {
	const action = asRecord(value);
	if (!action || (action.type !== "request" && action.type !== "continue" && action.type !== "wake")) {
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_INVALID_ACTION",
			'Custom monitor must return an action with type "request", "continue", or "wake"',
		);
	}
	if (jsonByteLength(action) > MAX_ACTION_BYTES) {
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_ACTION_LIMIT",
			`Custom monitor action exceeds ${MAX_ACTION_BYTES} bytes`,
		);
	}
	if (action.type === "continue") {
		if (action.message !== undefined && typeof action.message !== "string") {
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_ACTION", "continue.message must be a string");
		}
		return {
			type: "continue",
			...(action.message === undefined ? {} : { message: action.message }),
			...(action.state === undefined ? {} : { state: validateState(action.state) }),
		};
	}
	if (action.type === "wake") {
		if (typeof action.eventId !== "string" || action.eventId.trim() === "") {
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_WAKE", "wake.eventId must be a non-empty string");
		}
		if (typeof action.message !== "string" || action.message.trim() === "") {
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_WAKE", "wake.message must be a non-empty string");
		}
		return {
			type: "wake",
			eventId: action.eventId,
			message: action.message,
			...(action.data === undefined ? {} : { data: validateState(action.data) }),
			...(action.state === undefined ? {} : { state: validateState(action.state) }),
		};
	}
	const request = asRecord(action.request);
	if (!request || typeof request.kind !== "string") {
		throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_REQUEST", "request action requires request.kind");
	}
	const state = action.state === undefined ? undefined : validateState(action.state);
	if (request.kind === "file_stat") {
		if (typeof request.path !== "string" || request.path.trim() === "")
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_REQUEST",
				"file_stat.path must be a non-empty string",
			);
		if (request.includeHash !== undefined && typeof request.includeHash !== "boolean")
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_REQUEST", "file_stat.includeHash must be a boolean");
		return {
			type: "request",
			request: { kind: "file_stat", path: request.path, includeHash: request.includeHash === true },
			...(state === undefined ? {} : { state }),
		};
	}
	if (request.kind === "file_read") {
		if (typeof request.path !== "string" || request.path.trim() === "")
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_REQUEST",
				"file_read.path must be a non-empty string",
			);
		if (
			request.maxBytes !== undefined &&
			(typeof request.maxBytes !== "number" || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1)
		)
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_REQUEST",
				"file_read.maxBytes must be a positive integer",
			);
		return {
			type: "request",
			request: { kind: "file_read", path: request.path, maxBytes: request.maxBytes as number | undefined },
			...(state === undefined ? {} : { state }),
		};
	}
	if (request.kind === "task_status") {
		if (typeof request.taskId !== "string" || request.taskId.trim() === "")
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_REQUEST",
				"task_status.taskId must be a non-empty string",
			);
		return {
			type: "request",
			request: { kind: "task_status", taskId: request.taskId },
			...(state === undefined ? {} : { state }),
		};
	}
	if (request.kind === "process_status") {
		if (typeof request.pid !== "number" || !Number.isSafeInteger(request.pid) || request.pid < 1)
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_REQUEST",
				"process_status.pid must be a positive integer",
			);
		return {
			type: "request",
			request: { kind: "process_status", pid: request.pid },
			...(state === undefined ? {} : { state }),
		};
	}
	if (request.kind === "http") {
		if (typeof request.url !== "string" || request.url.trim() === "")
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_REQUEST", "http.url must be a non-empty string");
		if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD")
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_HTTP_METHOD",
				"Custom monitor HTTP supports only GET and HEAD",
			);
		return {
			type: "request",
			request: { kind: "http", url: request.url, method: request.method ?? "GET" },
			...(state === undefined ? {} : { state }),
		};
	}
	throw new CustomMonitorWakeError(
		"CUSTOM_MONITOR_INVALID_REQUEST",
		`Unsupported custom monitor request: ${request.kind}`,
	);
}

async function executeQuickJSSample(script: string, frame: Record<string, JsonValue>): Promise<MonitorAction> {
	const quickJS = await getQuickJSModule();
	const runtime = quickJS.newRuntime();
	runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);
	runtime.setMaxStackSize(SCRIPT_STACK_BYTES);
	const deadline = Date.now() + SCRIPT_DEADLINE_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const context = runtime.newContext();
	try {
		const serializedFrame = JSON.stringify(frame);
		const wrapped = [
			'"use strict";',
			script,
			'if (typeof monitor !== "function") throw new Error("Script must define function monitor(frame)");',
			`JSON.stringify(monitor(JSON.parse(${JSON.stringify(serializedFrame)})));`,
		].join("\n");
		const result = context.evalCode(wrapped, "custom-monitor.js", { type: "global" });
		if (result.error) {
			const dumped = context.dump(result.error) as unknown;
			result.error.dispose();
			const detail = asRecord(dumped);
			const message = detail?.message ? String(detail.message) : String(dumped);
			const code = /interrupted/i.test(message)
				? "CUSTOM_MONITOR_CPU_LIMIT"
				: /out of memory/i.test(message)
					? "CUSTOM_MONITOR_MEMORY_LIMIT"
					: "CUSTOM_MONITOR_SCRIPT_ERROR";
			throw new CustomMonitorWakeError(code, `Custom monitor script failed: ${message}`);
		}
		const dumped = context.dump(result.value) as unknown;
		result.value.dispose();
		if (typeof dumped !== "string") {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_ACTION",
				"Custom monitor result must be JSON-serializable",
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(dumped);
		} catch {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_ACTION",
				"Custom monitor result must be JSON-serializable",
			);
		}
		return validateAction(value);
	} finally {
		context.dispose();
		runtime.dispose();
	}
}

export class CustomMonitorManager implements MonitorAdapter {
	readonly name = "custom_monitor";
	private readonly taskManager: BackgroundTaskManager;
	private readonly processStateAdapter: ProcessStateAdapter;
	private readonly policyForRoot?: (root: string) => CustomMonitorPolicy;
	private readonly monitors = new Map<string, RegisteredMonitor>();

	constructor(options: {
		taskManager: BackgroundTaskManager;
		processStateAdapter: ProcessStateAdapter;
		policyForRoot?: (root: string) => CustomMonitorPolicy;
	}) {
		this.taskManager = options.taskManager;
		this.processStateAdapter = options.processStateAdapter;
		this.policyForRoot = options.policyForRoot;
	}

	async register(input: {
		root: string;
		sessionId: string;
		scriptPath: string;
		requestedOrigins?: string[];
	}): Promise<{ monitorId: string; scriptPath: string; scriptSha256: string; allowedOrigins: string[] }> {
		const root = resolve(input.root);
		const policy = this.policyForRoot?.(root) ?? {
			enabled: false,
			projectTrusted: false,
			allowedOrigins: [],
		};
		if (!policy.projectTrusted) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_UNTRUSTED_PROJECT",
				"Custom monitors require a trusted project",
			);
		}
		if (!policy.enabled) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_DISABLED",
				"Custom monitors are disabled by global or project settings",
			);
		}
		const policyOrigins = new Set(policy.allowedOrigins.map(normalizeOrigin));
		const requestedOrigins = (input.requestedOrigins ?? []).map(normalizeOrigin);
		const denied = requestedOrigins.filter((origin) => !policyOrigins.has(origin));
		if (denied.length > 0) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_ORIGIN_NOT_ALLOWED",
				`Requested origins exceed the global allowlist: ${denied.join(", ")}`,
			);
		}
		const candidate = resolve(root, input.scriptPath);
		if (!isWithin(candidate, root)) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT",
				"Custom monitor script must stay inside the current project directory",
			);
		}
		const scriptPath = await realpath(candidate).catch((error: unknown) => {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_SCRIPT_UNAVAILABLE",
				`Cannot read custom monitor script: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (!isWithin(scriptPath, root)) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT",
				"Custom monitor script symlink target must stay inside the current project directory",
			);
		}
		const metadata = await stat(scriptPath);
		if (!metadata.isFile() || metadata.size > MAX_SCRIPT_BYTES) {
			throw new CustomMonitorPolicyError(
				"CUSTOM_MONITOR_SCRIPT_LIMIT",
				`Custom monitor script must be a file no larger than ${MAX_SCRIPT_BYTES} bytes`,
			);
		}
		const script = await readFile(scriptPath, "utf8");
		const scriptSha256 = createHash("sha256").update(script).digest("hex");
		const id = randomUUID();
		this.monitors.set(id, {
			id,
			root,
			sessionId: input.sessionId,
			scriptPath,
			scriptSha256,
			script,
			allowedOrigins: new Set(requestedOrigins),
			state: null,
			seenEventIds: new Set(),
		});
		return { monitorId: id, scriptPath, scriptSha256, allowedOrigins: requestedOrigins };
	}

	dispose(monitorId: string): void {
		this.monitors.delete(monitorId);
	}

	clear(): void {
		this.monitors.clear();
	}

	private getMonitor(source: Record<string, JsonValue>): RegisteredMonitor {
		const monitorId = source.monitorId;
		if (typeof monitorId !== "string" || monitorId === "") {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_INVALID_SOURCE",
				"custom_monitor source.monitorId is required",
			);
		}
		const monitor = this.monitors.get(monitorId);
		if (!monitor) {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_NOT_REGISTERED",
				"Custom monitor state is unavailable; wake and register it again",
			);
		}
		return monitor;
	}

	private async resolveProjectFile(monitor: RegisteredMonitor, requestedPath: string): Promise<string> {
		const candidate = resolve(monitor.root, requestedPath);
		if (!isWithin(candidate, monitor.root)) {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT",
				`Custom monitor file request is outside the project: ${requestedPath}`,
			);
		}
		const actual = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return candidate;
			throw error;
		});
		if (!isWithin(actual, monitor.root)) {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_PATH_OUTSIDE_PROJECT",
				`Custom monitor file symlink target is outside the project: ${requestedPath}`,
			);
		}
		return actual;
	}

	private assertAllowedUrl(monitor: RegisteredMonitor, value: string): URL {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_INVALID_URL", `Invalid custom monitor URL: ${value}`);
		}
		if (!monitor.allowedOrigins.has(url.origin)) {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_ORIGIN_NOT_ALLOWED",
				`Custom monitor URL origin is not allowed: ${url.origin}`,
			);
		}
		if (url.username || url.password) {
			throw new CustomMonitorWakeError(
				"CUSTOM_MONITOR_URL_CREDENTIALS",
				"Custom monitor URLs cannot contain credentials",
			);
		}
		return url;
	}

	private async requestHttp(monitor: RegisteredMonitor, request: Extract<MonitorRequest, { kind: "http" }>) {
		let url = this.assertAllowedUrl(monitor, request.url);
		const method = request.method ?? "GET";
		for (let redirects = 0; redirects <= MAX_HTTP_REDIRECTS; redirects++) {
			const response = await fetch(url, {
				method,
				redirect: "manual",
				credentials: "omit",
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) break;
				if (redirects === MAX_HTTP_REDIRECTS) {
					throw new CustomMonitorWakeError(
						"CUSTOM_MONITOR_HTTP_REDIRECT_LIMIT",
						"Custom monitor HTTP redirect limit exceeded",
					);
				}
				url = this.assertAllowedUrl(monitor, new URL(location, url).toString());
				continue;
			}
			const headers: Record<string, string> = {};
			for (const name of ["content-type", "content-length", "etag", "last-modified"]) {
				const value = response.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			let body = "";
			let truncated = false;
			if (method !== "HEAD" && response.body) {
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let total = 0;
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					if (total + item.value.byteLength > MAX_HTTP_BODY_BYTES) {
						const remaining = MAX_HTTP_BODY_BYTES - total;
						if (remaining > 0) chunks.push(item.value.subarray(0, remaining));
						truncated = true;
						await reader.cancel();
						break;
					}
					chunks.push(item.value);
					total += item.value.byteLength;
				}
				body = Buffer.concat(chunks).toString("utf8");
			}
			return { url: url.toString(), status: response.status, ok: response.ok, headers, body, truncated };
		}
		throw new CustomMonitorWakeError("CUSTOM_MONITOR_HTTP_FAILED", "Custom monitor HTTP request failed");
	}

	private async executeRequest(monitor: RegisteredMonitor, request: MonitorRequest): Promise<JsonValue> {
		if (request.kind === "file_stat") {
			const path = await this.resolveProjectFile(monitor, request.path);
			try {
				const metadata = await stat(path);
				const result: Record<string, JsonValue> = {
					path: request.path,
					exists: true,
					type: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other",
					size: metadata.size,
					mtimeMs: metadata.mtimeMs,
				};
				if (request.includeHash && metadata.isFile()) {
					if (metadata.size > MAX_FILE_READ_BYTES) {
						throw new CustomMonitorWakeError(
							"CUSTOM_MONITOR_FILE_LIMIT",
							`Cannot hash a file larger than ${MAX_FILE_READ_BYTES} bytes`,
						);
					}
					result.sha256 = createHash("sha256")
						.update(await readFile(path))
						.digest("hex");
				}
				return result;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: request.path, exists: false };
				throw error;
			}
		}
		if (request.kind === "file_read") {
			const path = await this.resolveProjectFile(monitor, request.path);
			const maximum = Math.min(request.maxBytes ?? MAX_FILE_READ_BYTES, MAX_FILE_READ_BYTES);
			const metadata = await stat(path);
			if (!metadata.isFile())
				throw new CustomMonitorWakeError("CUSTOM_MONITOR_FILE_TYPE", "file_read requires a file");
			const handle = await open(path, "r");
			try {
				const size = Math.min(metadata.size, maximum);
				const buffer = Buffer.alloc(size);
				const { bytesRead } = await handle.read(buffer, 0, size, 0);
				return {
					path: request.path,
					text: buffer.subarray(0, bytesRead).toString("utf8"),
					bytesRead,
					truncated: metadata.size > bytesRead,
				};
			} finally {
				await handle.close();
			}
		}
		if (request.kind === "task_status") {
			const task = this.taskManager.get(request.taskId);
			if (!task || task.sessionId !== monitor.sessionId) {
				throw new CustomMonitorWakeError(
					"CUSTOM_MONITOR_TASK_NOT_FOUND",
					`Managed task not found: ${request.taskId}`,
				);
			}
			return {
				taskId: task.id,
				status: task.status,
				finished: task.status === "succeeded" || task.status === "failed" || task.status === "cancelled",
				exitCode: task.exitCode ?? null,
				logPath: task.logPath,
			};
		}
		if (request.kind === "process_status") {
			const observation = await this.processStateAdapter.observe({ pid: request.pid });
			return observation.fields;
		}
		return this.requestHttp(monitor, request);
	}

	async observe(source: Record<string, JsonValue>, signal?: AbortSignal): Promise<MonitorObservation> {
		if (signal?.aborted)
			throw new CustomMonitorWakeError("CUSTOM_MONITOR_ABORTED", "Custom monitor observation aborted");
		const monitor = this.getMonitor(source);
		let lastResult: JsonValue = null;
		for (let index = 0; index < MAX_REQUESTS_PER_SAMPLE; index++) {
			let action: MonitorAction;
			try {
				action = await executeQuickJSSample(monitor.script, {
					now: new Date().toISOString(),
					state: monitor.state,
					lastResult,
					requestIndex: index,
				});
			} catch (error) {
				if (error instanceof CustomMonitorWakeError) throw error;
				const detail = monitorErrorDetails(error);
				throw new CustomMonitorWakeError(detail.code, detail.message);
			}
			if (action.state !== undefined) monitor.state = validateState(action.state);
			if (action.type === "request") {
				lastResult = await this.executeRequest(monitor, action.request).catch((error: unknown) => {
					if (error instanceof CustomMonitorWakeError) throw error;
					const detail = monitorErrorDetails(error);
					throw new CustomMonitorWakeError(detail.code, detail.message);
				});
				continue;
			}
			if (action.type === "continue") {
				return {
					observedAt: new Date().toISOString(),
					fields: { wakeRequested: false, monitorId: monitor.id, scriptSha256: monitor.scriptSha256 },
					summary: action.message?.trim() || `Custom monitor ${monitor.id} is waiting`,
				};
			}
			if (monitor.seenEventIds.has(action.eventId)) {
				throw new CustomMonitorWakeError(
					"CUSTOM_MONITOR_DUPLICATE_EVENT",
					`Custom monitor emitted duplicate eventId: ${action.eventId}`,
				);
			}
			monitor.seenEventIds.add(action.eventId);
			const wakeEvent: Record<string, JsonValue> = {
				eventId: action.eventId,
				message: action.message,
				data: action.data ?? null,
			};
			return {
				observedAt: new Date().toISOString(),
				eventId: action.eventId,
				fields: {
					wakeRequested: true,
					monitorId: monitor.id,
					scriptSha256: monitor.scriptSha256,
					wakeEvent,
				},
				summary: `Custom monitor requested wake: ${action.message}`,
			};
		}
		throw new CustomMonitorWakeError(
			"CUSTOM_MONITOR_REQUEST_LIMIT",
			`Custom monitor exceeded ${MAX_REQUESTS_PER_SAMPLE} host requests in one sample`,
		);
	}
}
