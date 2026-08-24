import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdout.write(JSON.stringify({ type: "rpc_ready", protocolVersion: 1, capabilities: [] }) + "\\n");
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("waits for the ready handshake and exposes typed protocol events", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
setTimeout(() => {
	process.stdout.write(JSON.stringify({ type: "rpc_ready", protocolVersion: 1, capabilities: ["automations"] }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "automation_changed", automations: [] }) + "\\n");
}, 40);
process.stdin.resume();
`),
		});
		const automationEvent = new Promise<void>((resolve) => {
			client.onProtocolEvent((event) => {
				if (event.type === "automation_changed") resolve();
			});
		});
		const startedAt = Date.now();
		await client.start();
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
		await automationEvent;
		await client.stop();
	});

	test("supports an explicit executable and arguments", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-rpc-client-executable-"));
		tempDirs.push(directory);
		const argvPath = join(directory, "argv.json");
		const scriptPath = join(directory, "child.mjs");
		writeFileSync(
			scriptPath,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.RPC_ARGV_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "rpc_ready", protocolVersion: 1, capabilities: [] }) + "\\n");
process.stdin.resume();`,
		);
		const client = new RpcClient({
			executablePath: process.execPath,
			executableArgs: [scriptPath],
			env: { RPC_ARGV_PATH: argvPath },
		});
		await client.start();
		expect(JSON.parse(readFileSync(argvPath, "utf8"))).toEqual(["--mode", "rpc"]);
		await client.stop();
	});

	test("uses RPC input EOF for graceful shutdown", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-rpc-client-shutdown-"));
		tempDirs.push(directory);
		const markerPath = join(directory, "shutdown.txt");
		const client = new RpcClient({
			cliPath: writeChildScript(`
import { writeFileSync } from "node:fs";
process.stdout.write(JSON.stringify({ type: "rpc_ready", protocolVersion: 1, capabilities: [] }) + "\\n");
process.stdin.on("end", () => {
	writeFileSync(process.env.RPC_SHUTDOWN_MARKER, "graceful");
	process.exit(0);
});
process.stdin.resume();
`),
			env: { RPC_SHUTDOWN_MARKER: markerPath },
		});
		await client.start();
		await client.stop();
		expect(readFileSync(markerPath, "utf8")).toBe("graceful");
	});

	test("terminates the child when the ready handshake times out", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript("setInterval(() => {}, 1000);"),
			startupTimeoutMs: 30,
		});
		await expect(client.start()).rejects.toThrow(/Timeout waiting for rpc_ready/);
		await expect(client.getState()).rejects.toThrow(/Client not started/);
	});
});
