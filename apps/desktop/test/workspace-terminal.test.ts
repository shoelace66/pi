import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { TerminalService } from "../electron/services/terminal-service.ts";
import { listWorkspaceFiles, parseGitStatus } from "../electron/services/workspace-capabilities.ts";

test("parseGitStatus preserves paths, rename pairs, and both status columns", () => {
	const entries = parseGitStatus(
		" M spaced file.txt\0R  new name.txt\0old name.txt\0?? 中文.txt\0MM both.txt\0",
	);

	assert.deepEqual(entries, [
		{ path: "spaced file.txt", status: "·M", staged: false, unstaged: true },
		{
			path: "new name.txt",
			originalPath: "old name.txt",
			status: "R·",
			staged: true,
			unstaged: false,
		},
		{ path: "中文.txt", status: "??", staged: false, unstaged: true },
		{ path: "both.txt", status: "MM", staged: true, unstaged: true },
	]);
});

test("listWorkspaceFiles reports its limit instead of silently dropping entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-files-"));
	try {
		await Promise.all(
			Array.from({ length: 501 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, "0")}.txt`), "x")),
		);
		const listing = await listWorkspaceFiles(root);
		assert.equal(listing.entries.length, 500);
		assert.equal(listing.limit, 500);
		assert.equal(listing.truncated, true);
		assert.equal(listing.unreadableCount, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TerminalService keeps cwd across cd and reports command metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-terminal-"));
	const child = join(root, "folder with spaces");
	await mkdir(child);
	try {
		const service = new TerminalService();
		const changed = await service.run({ executionId: randomUUID(), cwd: root, command: 'cd "folder with spaces"' });
		assert.equal(changed.exitCode, 0);
		assert.equal(changed.nextCwd, child);
		assert.equal(changed.cancelled, false);
		assert.ok(changed.startedAt);
		assert.ok(changed.durationMs >= 0);

		const printed = await service.run({ executionId: randomUUID(), cwd: changed.nextCwd, command: "pwd" });
		assert.equal(printed.stdout, child);
		assert.equal(printed.nextCwd, child);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TerminalService stops a running process", { timeout: 8_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-terminal-abort-"));
	try {
		const service = new TerminalService();
		const executionId = randomUUID();
		const resultPromise = service.run({
			executionId,
			cwd: root,
			command: process.platform === "win32" ? "pause" : "sleep 10",
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(await service.abort(executionId), true);
		const result = await resultPromise;
		assert.equal(result.cancelled, true);
		assert.notEqual(result.exitCode, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
