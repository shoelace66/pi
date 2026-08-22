import { execFile } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DesktopChangeEntry, DesktopFileListing, DesktopWorkspaceChanges } from "../../shared/view-models.ts";

const execFileAsync = promisify(execFile);
const FILE_LIMIT = 500;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export async function listWorkspaceFiles(workspacePath: string): Promise<DesktopFileListing> {
	const entries: DesktopFileListing["entries"] = [];
	let truncated = false;
	let unreadableCount = 0;

	async function visit(directory: string): Promise<void> {
		let children: Dirent<string>[];
		try {
			children = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			unreadableCount += 1;
			return;
		}
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			if (entries.length >= FILE_LIMIT) {
				truncated = true;
				break;
			}
			if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
			const absolute = join(directory, child.name);
			const relative = absolute.slice(workspacePath.length + 1).replaceAll("\\", "/");
			if (child.isDirectory()) {
				entries.push({ path: relative, name: child.name, kind: "directory" });
				await visit(absolute);
			} else if (child.isFile()) {
				try {
					const info = await fs.stat(absolute);
					entries.push({
						path: relative,
						name: child.name,
						kind: "file",
						size: info.size,
						modifiedAt: info.mtime.toISOString(),
					});
				} catch {
					unreadableCount += 1;
				}
			}
		}
	}

	await visit(workspacePath);
	return { entries, truncated, limit: FILE_LIMIT, unreadableCount };
}

export function parseGitStatus(output: string): DesktopChangeEntry[] {
	const records = output.split("\0");
	const entries: DesktopChangeEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 3) continue;
		const indexStatus = record[0] ?? " ";
		const worktreeStatus = record[1] ?? " ";
		const entry: DesktopChangeEntry = {
			path: record.slice(3),
			status: `${indexStatus === " " ? "·" : indexStatus}${worktreeStatus === " " ? "·" : worktreeStatus}`,
			staged: indexStatus !== " " && indexStatus !== "?",
			unstaged: worktreeStatus !== " " || indexStatus === "?",
		};
		if ([indexStatus, worktreeStatus].some((value) => value === "R" || value === "C")) {
			entry.originalPath = records[index + 1] || undefined;
			index += 1;
		}
		entries.push(entry);
	}
	return entries;
}

export async function workspaceChanges(workspacePath: string): Promise<DesktopWorkspaceChanges> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd: workspacePath,
			windowsHide: true,
			maxBuffer: 4_000_000,
			encoding: "utf8",
		});
		return { repository: true, entries: parseGitStatus(stdout) };
	} catch (reason) {
		const message = reason instanceof Error ? reason.message : String(reason);
		if (/not a git repository/i.test(message)) return { repository: false, entries: [] };
		return { repository: false, entries: [], error: message };
	}
}
