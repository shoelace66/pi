import { type ChildProcess, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RunTerminalRequest } from "../../shared/ipc-contract.ts";
import type { DesktopTerminalResult } from "../../shared/view-models.ts";

type RunningCommand = {
	child: ChildProcess;
	controller: AbortController;
	cancelled: boolean;
	closed: Promise<void>;
};

function validDirectory(path: string): string {
	if (!isAbsolute(path)) throw new Error("A valid terminal directory is required");
	const resolved = resolve(path);
	try {
		if (statSync(resolved).isDirectory()) return resolved;
	} catch {
		// The shared validation message is clearer than platform-specific fs errors.
	}
	throw new Error("A valid terminal directory is required");
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
		return trimmed.slice(1, -1);
	return trimmed;
}

function builtInDirectory(command: string, cwd: string): string | undefined {
	const match = /^(?:cd|chdir)(?:\s+\/d)?(?:\s+(.*))?$/i.exec(command);
	if (!match) return undefined;
	const target = match[1] ? unquote(match[1]) : cwd;
	return validDirectory(isAbsolute(target) ? target : resolve(cwd, target));
}

export class TerminalService {
	readonly #running = new Map<string, RunningCommand>();

	async run(request: RunTerminalRequest): Promise<DesktopTerminalResult> {
		if (!request.executionId.trim()) throw new Error("Terminal execution id is required");
		if (this.#running.has(request.executionId)) throw new Error("Terminal execution id is already running");
		const cwd = validDirectory(request.cwd);
		const command = request.command.trim();
		if (!command) throw new Error("Terminal command cannot be empty");
		const started = Date.now();
		const startedAt = new Date(started).toISOString();

		if (/^(?:pwd|cd|chdir)(?:\s|$)/i.test(command)) {
			try {
				const nextCwd = /^pwd$/i.test(command) ? cwd : (builtInDirectory(command, cwd) ?? cwd);
				return this.#result(request, cwd, nextCwd, nextCwd, "", 0, started, startedAt, false);
			} catch (reason) {
				return this.#result(request, cwd, cwd, "", String(reason), 1, started, startedAt, false);
			}
		}

		return await new Promise<DesktopTerminalResult>((resolveResult) => {
			const controller = new AbortController();
			const executable =
				process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
			const shellCommand = process.platform === "win32" ? `chcp 65001>nul & ${command}` : command;
			const args = process.platform === "win32" ? ["/d", "/s", "/c", shellCommand] : ["-lc", shellCommand];
			const child = execFile(
				executable,
				args,
				{ cwd, windowsHide: true, maxBuffer: 8_000_000, encoding: "utf8", signal: controller.signal },
				(error, stdout, stderr) => {
					const running = this.#running.get(request.executionId);
					this.#running.delete(request.executionId);
					const failure = error as (Error & { code?: number | string }) | null;
					resolveResult(
						this.#result(
							request,
							cwd,
							cwd,
							stdout,
							stderr || (failure && typeof failure.code !== "number" ? failure.message : ""),
							failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
							started,
							startedAt,
							running?.cancelled ?? false,
						),
					);
				},
			);
			const closed = new Promise<void>((resolveClosed) => {
				child.once("close", () => resolveClosed());
			});
			this.#running.set(request.executionId, { child, controller, cancelled: false, closed });
		});
	}

	async abort(executionId: string): Promise<boolean> {
		const running = this.#running.get(executionId);
		if (!running) return false;
		running.cancelled = true;
		const pid = running.child.pid;
		if (process.platform === "win32" && pid) {
			await new Promise<void>((resolveKill) => {
				execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolveKill());
			});
		}
		running.controller.abort();
		await running.closed;
		return true;
	}

	#result(
		request: RunTerminalRequest,
		cwd: string,
		nextCwd: string,
		stdout: string,
		stderr: string,
		exitCode: number,
		started: number,
		startedAt: string,
		cancelled: boolean,
	): DesktopTerminalResult {
		const completed = Date.now();
		return {
			executionId: request.executionId,
			command: request.command.trim(),
			cwd,
			nextCwd,
			stdout,
			stderr,
			exitCode,
			startedAt,
			completedAt: new Date(completed).toISOString(),
			durationMs: completed - started,
			cancelled,
		};
	}
}
