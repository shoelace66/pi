import { execFile } from "node:child_process";
import type { MonitorAdapter } from "../monitor-registry.ts";
import type { JsonValue, MonitorObservation } from "../types.ts";

export type ProcessState = {
	pid: number;
	exists: boolean;
	running: boolean;
	status: "running" | "exited" | "not_found";
	exitCode?: number;
};

export type ProcessStateQuery = (pid: number, signal?: AbortSignal) => Promise<ProcessState>;

export type ProcessStateAdapterOptions = {
	platform?: NodeJS.Platform;
	query?: ProcessStateQuery;
};

export class ProcessStateError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ProcessStateError";
		this.code = code;
	}
}

function requirePid(source: Record<string, JsonValue>): number {
	const pid = source.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
		throw new ProcessStateError("PROCESS_STATE_INVALID_PID", "process_state source.pid must be a positive integer");
	}
	return pid;
}

function parseWindowsResult(stdout: string, pid: number): ProcessState {
	const text = stdout.trim();
	if (!text)
		throw new ProcessStateError("PROCESS_STATE_INVALID_OUTPUT", `process_state returned no data for PID ${pid}`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new ProcessStateError(
			"PROCESS_STATE_INVALID_OUTPUT",
			`process_state returned invalid JSON for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!value || typeof value !== "object")
		throw new ProcessStateError(
			"PROCESS_STATE_INVALID_OUTPUT",
			`process_state returned an invalid result for PID ${pid}`,
		);
	const result = value as Record<string, unknown>;
	if (result.pid !== pid || typeof result.exists !== "boolean" || typeof result.running !== "boolean") {
		throw new ProcessStateError(
			"PROCESS_STATE_INVALID_OUTPUT",
			`process_state returned malformed fields for PID ${pid}`,
		);
	}
	if (result.status !== "running" && result.status !== "exited" && result.status !== "not_found") {
		throw new ProcessStateError(
			"PROCESS_STATE_INVALID_OUTPUT",
			`process_state returned an invalid status for PID ${pid}`,
		);
	}
	const state: ProcessState = {
		pid,
		exists: result.exists,
		running: result.running,
		status: result.status,
	};
	if (result.exitCode !== undefined) {
		if (typeof result.exitCode !== "number" || !Number.isSafeInteger(result.exitCode)) {
			throw new ProcessStateError(
				"PROCESS_STATE_INVALID_OUTPUT",
				`process_state returned an invalid exitCode for PID ${pid}`,
			);
		}
		state.exitCode = result.exitCode;
	}
	return state;
}

function queryWindowsProcess(pid: number, signal?: AbortSignal): Promise<ProcessState> {
	// Get-Process is used only for observation. The script contains no operation
	// that mutates or controls the target process.
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$targetPid = ${pid}`,
		"$queryErrors = @()",
		"$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue -ErrorVariable queryErrors",
		"if ($null -eq $process) {",
		"  $unexpected = @($queryErrors | Where-Object { $_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*' })",
		"  if ($unexpected.Count -gt 0) { throw $unexpected[0] }",
		"  [ordered]@{ pid = $targetPid; exists = $false; running = $false; status = 'not_found' } | ConvertTo-Json -Compress",
		"  exit 0",
		"}",
		"$hasExited = $process.HasExited",
		"$result = [ordered]@{ pid = $targetPid; exists = $true; running = (-not $hasExited); status = $(if ($hasExited) { 'exited' } else { 'running' }) }",
		"if ($hasExited) {",
		"  try { $result.exitCode = $process.ExitCode } catch { }",
		"}",
		"$result | ConvertTo-Json -Compress",
	].join("\n");

	return new Promise((resolvePromise, reject) => {
		execFile(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, signal },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(
						new ProcessStateError(
							"PROCESS_STATE_QUERY_FAILED",
							`process_state failed to query PID ${pid}: ${detail}`,
						),
					);
					return;
				}
				try {
					resolvePromise(parseWindowsResult(stdout, pid));
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
	});
}

/** Windows-first, read-only process state monitor. */
export class ProcessStateAdapter implements MonitorAdapter {
	readonly name = "process_state";
	private readonly platform: NodeJS.Platform;
	private readonly query: ProcessStateQuery;

	constructor(options: ProcessStateAdapterOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.query = options.query ?? queryWindowsProcess;
	}

	async observe(source: Record<string, JsonValue>, signal?: AbortSignal): Promise<MonitorObservation> {
		if (this.platform !== "win32") {
			throw new ProcessStateError(
				"PROCESS_STATE_UNSUPPORTED_PLATFORM",
				`process_state is currently supported only on Windows; current platform is ${this.platform}`,
			);
		}
		if (signal?.aborted) throw new Error("Process observation was aborted");
		const pid = requirePid(source);
		const state = await this.query(pid, signal);
		if (signal?.aborted) throw new Error("Process observation was aborted");
		const fields: Record<string, JsonValue> = {
			pid: state.pid,
			exists: state.exists,
			running: state.running,
			status: state.status,
		};
		if (state.exitCode !== undefined) fields.exitCode = state.exitCode;
		return {
			observedAt: new Date().toISOString(),
			fields,
			summary:
				state.exitCode === undefined
					? `Process ${pid}: ${state.status}`
					: `Process ${pid}: ${state.status} (exit code ${state.exitCode})`,
		};
	}
}

export function createProcessStateAdapter(options: ProcessStateAdapterOptions = {}): ProcessStateAdapter {
	return new ProcessStateAdapter(options);
}
