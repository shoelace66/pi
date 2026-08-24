import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeBackendTreeDigest, resolveBundledBackend } from "../src/backend-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function integrityKey(entry: { kind: string; path: string }): string {
	return `${entry.kind}:${entry.path}`;
}

async function createBackend(platform: "win32-x64" | "linux-x64", backendKind = "bun-compiled") {
	const extensionRoot = await mkdtemp(path.join(tmpdir(), "autopi-vscode-runtime-"));
	temporaryDirectories.push(extensionRoot);
	const backendRoot = path.join(extensionRoot, "resources", "backend");
	await mkdir(backendRoot, { recursive: true });
	const executableName = platform === "win32-x64" ? "autopi.exe" : "autopi";
	const executable = path.join(backendRoot, executableName);
	await writeFile(executable, "verified backend");

	const launchArguments: Array<Record<string, string>> = [];
	const integrityEntries: Array<{
		kind: string;
		path: string;
		sha256: string;
		size?: number;
		fileCount?: number;
		totalBytes?: number;
	}> = [
		{ kind: "file", path: executableName, sha256: sha256("verified backend"), size: 16 },
	];
	let cliEntrypoint: string | undefined;
	let runtimeRoot: string | undefined;
	let runtimeDependency: string | undefined;
	if (backendKind === "bundled-node") {
		runtimeRoot = "runtime";
		cliEntrypoint = "runtime/app/cli.js";
		runtimeDependency = path.join(backendRoot, "runtime", "node_modules", "dependency.js");
		await mkdir(path.dirname(runtimeDependency), { recursive: true });
		await mkdir(path.dirname(path.join(backendRoot, cliEntrypoint)), { recursive: true });
		await writeFile(path.join(backendRoot, cliEntrypoint), "CLI entrypoint");
		await writeFile(runtimeDependency, "runtime dependency");
		launchArguments.push(
			{ kind: "literal", value: "--no-warnings" },
			{ kind: "resource", path: cliEntrypoint, role: "cli-entrypoint" },
		);
		integrityEntries.push({
			kind: "file",
			path: cliEntrypoint,
			sha256: sha256("CLI entrypoint"),
			size: 14,
		});
		integrityEntries.push({ kind: "tree", path: runtimeRoot, ...computeBackendTreeDigest(path.join(backendRoot, runtimeRoot)) });
	}
	integrityEntries.sort((left, right) => integrityKey(left).localeCompare(integrityKey(right), "en"));

	const manifest = {
		schemaVersion: 2,
		platform,
		backendKind,
		launch: {
			executable: executableName,
			arguments: launchArguments,
			...(runtimeRoot ? { runtimeRoot } : {}),
		},
		integrity: { algorithm: "sha256", entries: integrityEntries },
	};
	const manifestPath = path.join(backendRoot, "build-manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest));
	return { extensionRoot, backendRoot, executable, cliEntrypoint, runtimeDependency, manifest, manifestPath };
}

describe("bundled VS Code backend resolution", () => {
	it("resolves and validates the Linux x64 executable", async () => {
		const backend = await createBackend("linux-x64");
		expect(resolveBundledBackend(backend.extensionRoot, "linux", "x64")).toEqual({
			executablePath: backend.executable,
			executableArgs: [],
		});
	});

	it("keeps literal arguments literal and resolves the bundled Node CLI resource", async () => {
		const backend = await createBackend("win32-x64", "bundled-node");
		expect(resolveBundledBackend(backend.extensionRoot, "win32", "x64")).toEqual({
			executablePath: backend.executable,
			executableArgs: ["--no-warnings", path.join(backend.backendRoot, backend.cliEntrypoint!)],
		});
	});

	it("rejects a bundled Node manifest without a declared CLI entrypoint", async () => {
		const backend = await createBackend("win32-x64", "bundled-node");
		delete backend.manifest.launch.arguments[1].role;
		await writeFile(backend.manifestPath, JSON.stringify(backend.manifest));
		expect(() => resolveBundledBackend(backend.extensionRoot, "win32", "x64")).toThrow(/CLI entrypoint/);
	});

	it("rejects a platform-specific VSIX on the wrong host", async () => {
		const backend = await createBackend("win32-x64");
		expect(() => resolveBundledBackend(backend.extensionRoot, "linux", "x64")).toThrow(/requires linux-x64/);
	});

	it("rejects an executable changed after packaging", async () => {
		const backend = await createBackend("linux-x64");
		await writeFile(backend.executable, "tampered backend");
		expect(() => resolveBundledBackend(backend.extensionRoot, "linux", "x64")).toThrow(/file does not match/);
	});

	it("rejects a bundled Node CLI entrypoint changed after packaging", async () => {
		const backend = await createBackend("win32-x64", "bundled-node");
		await writeFile(path.join(backend.backendRoot, backend.cliEntrypoint!), "tampered CLI");
		expect(() => resolveBundledBackend(backend.extensionRoot, "win32", "x64")).toThrow(/file does not match/);
	});

	it("rejects a changed or expanded bundled Node runtime tree", async () => {
		const changed = await createBackend("win32-x64", "bundled-node");
		await writeFile(changed.runtimeDependency!, "tampered dependency");
		expect(() => resolveBundledBackend(changed.extensionRoot, "win32", "x64")).toThrow(/tree does not match/);

		const expanded = await createBackend("win32-x64", "bundled-node");
		await writeFile(path.join(expanded.backendRoot, "runtime", "unexpected.js"), "unexpected file");
		expect(() => resolveBundledBackend(expanded.extensionRoot, "win32", "x64")).toThrow(/tree does not match/);
	});

	it("rejects tampering in non-launch native runtime assets", async () => {
		const backend = await createBackend("win32-x64");
		const nativeRoot = path.join(backend.backendRoot, "native");
		const nativeFile = path.join(nativeRoot, "clipboard.node");
		await mkdir(nativeRoot, { recursive: true });
		await writeFile(nativeFile, "verified native module");
		backend.manifest.integrity.entries.push({
			kind: "tree",
			path: "native",
			...computeBackendTreeDigest(nativeRoot),
		});
		backend.manifest.integrity.entries.sort((left, right) => integrityKey(left).localeCompare(integrityKey(right), "en"));
		await writeFile(backend.manifestPath, JSON.stringify(backend.manifest));
		expect(() => resolveBundledBackend(backend.extensionRoot, "win32", "x64")).not.toThrow();

		await writeFile(nativeFile, "tampered native module");
		expect(() => resolveBundledBackend(backend.extensionRoot, "win32", "x64")).toThrow(/tree does not match/);
	});

	it("rejects an unlisted top-level backend resource", async () => {
		const backend = await createBackend("linux-x64");
		await writeFile(path.join(backend.backendRoot, "unlisted.wasm"), "unexpected resource");
		expect(() => resolveBundledBackend(backend.extensionRoot, "linux", "x64")).toThrow(/missing from the integrity contract/);
	});

	it("rejects manifest paths outside the extension resources", async () => {
		const backend = await createBackend("linux-x64");
		backend.manifest.launch.executable = "../../outside";
		backend.manifest.integrity.entries = [
			{ kind: "file", path: "../../outside", sha256: "00".repeat(32), size: 0 },
		];
		await writeFile(backend.manifestPath, JSON.stringify(backend.manifest));
		expect(() => resolveBundledBackend(backend.extensionRoot, "linux", "x64")).toThrow(/escapes/);
	});

	it("rejects legacy manifests without the complete integrity contract", async () => {
		const backend = await createBackend("win32-x64");
		const legacy = {
			schemaVersion: 1,
			platform: "win32-x64",
			backendExecutable: "node.exe",
			backendSha256: sha256("verified backend"),
		};
		await writeFile(backend.manifestPath, JSON.stringify(legacy));
		expect(() => resolveBundledBackend(backend.extensionRoot, "win32", "x64")).toThrow(/manifest is invalid/);
	});

	it("computes the same tree digest regardless of directory enumeration order", async () => {
		const backend = await createBackend("win32-x64", "bundled-node");
		const runtime = path.join(backend.backendRoot, "runtime");
		const first = computeBackendTreeDigest(runtime);
		const cliContents = await readFile(path.join(backend.backendRoot, backend.cliEntrypoint!), "utf8");
		await writeFile(path.join(backend.backendRoot, backend.cliEntrypoint!), cliContents);
		expect(computeBackendTreeDigest(runtime)).toEqual(first);
	});
});
