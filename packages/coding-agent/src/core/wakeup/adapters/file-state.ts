import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { MonitorAdapter } from "../monitor-registry.ts";
import type { JsonValue, MonitorObservation } from "../types.ts";

export type FileStateAdapterOptions = {
	/** Only these directories may be observed. Symlink targets are checked too. */
	allowedRoots: string[];
	maxHashBytes?: number;
};

function isWithin(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getString(source: Record<string, JsonValue>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function getBoolean(source: Record<string, JsonValue>, key: string, fallback: boolean): boolean {
	const value = source[key];
	return typeof value === "boolean" ? value : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Monitor observation was aborted");
}

/**
 * Built-in monitor for files and directories. It intentionally exposes only
 * metadata by default; hashing is opt-in and bounded to avoid turning a
 * monitor tick into an unbounded file read.
 */
export class FileStateAdapter implements MonitorAdapter {
	readonly name = "file_state";
	private readonly allowedRoots: string[];
	private readonly maxHashBytes: number;

	constructor(options: FileStateAdapterOptions) {
		if (options.allowedRoots.length === 0) throw new Error("file_state requires at least one allowed root");
		this.allowedRoots = options.allowedRoots.map((root) => resolve(root));
		this.maxHashBytes = options.maxHashBytes ?? 5 * 1024 * 1024;
	}

	addAllowedRoot(root: string): void {
		const resolvedRoot = resolve(root);
		if (!this.allowedRoots.includes(resolvedRoot)) this.allowedRoots.push(resolvedRoot);
	}

	private assertAllowed(path: string): void {
		if (!this.allowedRoots.some((root) => isWithin(path, root))) {
			throw new Error(`file_state path is outside the allowed roots: ${path}`);
		}
	}

	async observe(source: Record<string, JsonValue>, signal?: AbortSignal): Promise<MonitorObservation> {
		throwIfAborted(signal);
		const requestedPath = getString(source, "path");
		if (!requestedPath || !isAbsolute(requestedPath))
			throw new Error("file_state source.path must be an absolute path");
		const candidate = resolve(requestedPath);
		this.assertAllowed(candidate);

		let realPath: string;
		try {
			realPath = await realpath(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					observedAt: new Date().toISOString(),
					fields: { path: candidate, exists: false },
					summary: `Path does not exist: ${candidate}`,
				};
			}
			throw error;
		}
		this.assertAllowed(realPath);
		throwIfAborted(signal);

		const metadata = await stat(realPath);
		const type = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other";
		const fields: Record<string, JsonValue> = {
			path: candidate,
			realPath,
			exists: true,
			type,
			size: metadata.size,
			mtimeMs: metadata.mtimeMs,
			ctimeMs: metadata.ctimeMs,
		};

		if (getBoolean(source, "includeHash", false) && type === "file") {
			if (metadata.size > this.maxHashBytes) {
				fields.hashSkipped = true;
				fields.hashSkipReason = `file exceeds maxHashBytes (${this.maxHashBytes})`;
			} else {
				throwIfAborted(signal);
				const contents = await readFile(realPath);
				fields.sha256 = createHash("sha256").update(contents).digest("hex");
			}
		}

		return {
			observedAt: new Date().toISOString(),
			fields,
			summary: `${type} state: ${candidate} (mtime ${metadata.mtimeMs})`,
		};
	}
}

export function createFileStateAdapter(options: FileStateAdapterOptions): FileStateAdapter {
	return new FileStateAdapter(options);
}
