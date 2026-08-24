import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import path from "node:path";

export type BundledBackendLaunch = {
	executablePath: string;
	executableArgs: string[];
};

type BackendLaunchArgument =
	| { kind: "literal"; value: string }
	| { kind: "resource"; path: string; role?: "cli-entrypoint" };

type BackendIntegrityEntry =
	| { kind: "file"; path: string; sha256: string; size: number }
	| { kind: "tree"; path: string; sha256: string; fileCount: number; totalBytes: number };

type BackendBuildManifest = {
	schemaVersion: 2;
	platform: string;
	backendKind: string;
	launch: {
		executable: string;
		arguments: BackendLaunchArgument[];
		runtimeRoot?: string;
	};
	integrity: {
		algorithm: "sha256";
		entries: BackendIntegrityEntry[];
	};
};

type TreeDigest = {
	sha256: string;
	fileCount: number;
	totalBytes: number;
};

function expectedTarget(platform: NodeJS.Platform, arch: string): string {
	if ((platform === "win32" || platform === "linux") && arch === "x64") return `${platform}-${arch}`;
	throw new Error(`The bundled AutoPi backend does not support ${platform}-${arch}`);
}

function resolveInside(root: string, relativePath: string): string {
	const resolved = path.resolve(root, relativePath);
	const fromRoot = path.relative(root, resolved);
	if (fromRoot === "" || (!fromRoot.startsWith(`..${path.sep}`) && fromRoot !== ".." && !path.isAbsolute(fromRoot))) {
		return resolved;
	}
	throw new Error(`AutoPi backend manifest path escapes its resource directory: ${relativePath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseLaunchArgument(value: unknown): BackendLaunchArgument | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "literal" && typeof value.value === "string") {
		return { kind: "literal", value: value.value };
	}
	if (
		value.kind === "resource" &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		(value.role === undefined || value.role === "cli-entrypoint")
	) {
		return {
			kind: "resource",
			path: value.path,
			...(value.role === "cli-entrypoint" ? { role: "cli-entrypoint" as const } : {}),
		};
	}
	return undefined;
}

function parseIntegrityEntry(value: unknown): BackendIntegrityEntry | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0 || !isSha256(value.sha256)) {
		return undefined;
	}
	if (value.kind === "file" && isNonNegativeInteger(value.size)) {
		return { kind: "file", path: value.path, sha256: value.sha256, size: value.size };
	}
	if (value.kind === "tree" && isNonNegativeInteger(value.fileCount) && isNonNegativeInteger(value.totalBytes)) {
		return {
			kind: "tree",
			path: value.path,
			sha256: value.sha256,
			fileCount: value.fileCount,
			totalBytes: value.totalBytes,
		};
	}
	return undefined;
}

function integrityKey(entry: BackendIntegrityEntry): string {
	return `${entry.kind}:${entry.path}`;
}

function readManifest(pathname: string): BackendBuildManifest {
	if (!existsSync(pathname)) throw new Error(`AutoPi backend build manifest is missing: ${pathname}`);
	const value: unknown = JSON.parse(readFileSync(pathname, "utf8"));
	if (
		!isRecord(value) ||
		value.schemaVersion !== 2 ||
		typeof value.platform !== "string" ||
		typeof value.backendKind !== "string" ||
		value.backendKind.length === 0 ||
		!isRecord(value.launch) ||
		typeof value.launch.executable !== "string" ||
		value.launch.executable.length === 0 ||
		!Array.isArray(value.launch.arguments) ||
		(value.launch.runtimeRoot !== undefined &&
			(typeof value.launch.runtimeRoot !== "string" || value.launch.runtimeRoot.length === 0)) ||
		!isRecord(value.integrity) ||
		value.integrity.algorithm !== "sha256" ||
		!Array.isArray(value.integrity.entries)
	) {
		throw new Error("AutoPi backend build manifest is invalid");
	}

	const launchArguments = value.launch.arguments.map(parseLaunchArgument);
	const integrityEntries = value.integrity.entries.map(parseIntegrityEntry);
	if (launchArguments.some((argument) => argument === undefined) || integrityEntries.some((entry) => entry === undefined)) {
		throw new Error("AutoPi backend build manifest is invalid");
	}

	const manifest: BackendBuildManifest = {
		schemaVersion: 2,
		platform: value.platform,
		backendKind: value.backendKind,
		launch: {
			executable: value.launch.executable,
			arguments: launchArguments as BackendLaunchArgument[],
			...(typeof value.launch.runtimeRoot === "string" ? { runtimeRoot: value.launch.runtimeRoot } : {}),
		},
		integrity: {
			algorithm: "sha256",
			entries: integrityEntries as BackendIntegrityEntry[],
		},
	};

	const integrityKeys = manifest.integrity.entries.map(integrityKey);
	const sortedKeys = [...integrityKeys].sort();
	if (new Set(integrityKeys).size !== integrityKeys.length || integrityKeys.some((key, index) => key !== sortedKeys[index])) {
		throw new Error("AutoPi backend integrity entries must be unique and sorted");
	}

	const filePaths = new Set(
		manifest.integrity.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
	);
	if (!filePaths.has(manifest.launch.executable)) {
		throw new Error("AutoPi backend executable is missing from the integrity contract");
	}
	for (const argument of manifest.launch.arguments) {
		if (argument.kind === "resource" && !filePaths.has(argument.path)) {
			throw new Error(`AutoPi backend launch resource is missing from the integrity contract: ${argument.path}`);
		}
	}

	if (manifest.launch.runtimeRoot) {
		if (!manifest.integrity.entries.some((entry) => entry.kind === "tree" && entry.path === manifest.launch.runtimeRoot)) {
			throw new Error("AutoPi backend runtime tree is missing from the integrity contract");
		}
	}
	if (manifest.backendKind === "bundled-node") {
		const cliEntrypoints = manifest.launch.arguments.filter(
			(argument): argument is Extract<BackendLaunchArgument, { kind: "resource" }> =>
				argument.kind === "resource" && argument.role === "cli-entrypoint",
		);
		if (cliEntrypoints.length !== 1 || !manifest.launch.runtimeRoot) {
			throw new Error("Bundled Node backend manifest must declare one CLI entrypoint and a runtime root");
		}
		const manifestRoot = path.dirname(pathname);
		const runtimeRoot = resolveInside(manifestRoot, manifest.launch.runtimeRoot);
		const cliEntrypoint = resolveInside(manifestRoot, cliEntrypoints[0].path);
		const relativeCli = path.relative(runtimeRoot, cliEntrypoint);
		if (relativeCli === "" || relativeCli === ".." || relativeCli.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCli)) {
			throw new Error("Bundled Node CLI entrypoint must be inside its runtime root");
		}
	}

	return manifest;
}

function sha256File(pathname: string): string {
	return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function treeFiles(root: string): Array<{ absolutePath: string; relativePath: string; size: number }> {
	const files: Array<{ absolutePath: string; relativePath: string; size: number }> = [];
	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort(comparePath)) {
			const absolutePath = path.join(directory, name);
			const metadata = lstatSync(absolutePath);
			if (metadata.isSymbolicLink()) {
				throw new Error(`AutoPi backend integrity tree contains a symbolic link: ${absolutePath}`);
			}
			if (metadata.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!metadata.isFile()) {
				throw new Error(`AutoPi backend integrity tree contains an unsupported entry: ${absolutePath}`);
			}
			files.push({
				absolutePath,
				relativePath: path.relative(root, absolutePath).replaceAll("\\", "/"),
				size: metadata.size,
			});
		}
	};
	visit(root);
	return files.sort((left, right) => comparePath(left.relativePath, right.relativePath));
}

export function computeBackendTreeDigest(root: string): TreeDigest {
	const digest = createHash("sha256");
	let totalBytes = 0;
	const files = treeFiles(root);
	for (const file of files) {
		const fileHash = sha256File(file.absolutePath);
		digest.update(`${file.relativePath}\0${file.size}\0${fileHash}\n`, "utf8");
		totalBytes += file.size;
	}
	return { sha256: digest.digest("hex"), fileCount: files.length, totalBytes };
}

function verifyIntegrity(backendRoot: string, entries: BackendIntegrityEntry[]): void {
	for (const entry of entries) {
		const resolved = resolveInside(backendRoot, entry.path);
		if (!existsSync(resolved)) throw new Error(`AutoPi backend integrity resource is missing: ${resolved}`);
		if (entry.kind === "file") {
			const metadata = lstatSync(resolved);
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new Error(`AutoPi backend integrity resource is not a regular file: ${resolved}`);
			}
			if (metadata.size !== entry.size || sha256File(resolved).toLowerCase() !== entry.sha256.toLowerCase()) {
				throw new Error(`AutoPi backend file does not match its integrity contract: ${entry.path}`);
			}
			continue;
		}
		const metadata = lstatSync(resolved);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(`AutoPi backend integrity tree is not a directory: ${resolved}`);
		}
		const actual = computeBackendTreeDigest(resolved);
		if (
			actual.sha256.toLowerCase() !== entry.sha256.toLowerCase() ||
			actual.fileCount !== entry.fileCount ||
			actual.totalBytes !== entry.totalBytes
		) {
			throw new Error(`AutoPi backend tree does not match its integrity contract: ${entry.path}`);
		}
	}
}

function verifyIntegrityCoverage(backendRoot: string, entries: BackendIntegrityEntry[]): void {
	const coveredTopLevel = new Set(
		entries
			.filter((entry) => !entry.path.includes("/") && !entry.path.includes("\\"))
			.map((entry) => entry.path),
	);
	const actualTopLevel = readdirSync(backendRoot).filter((name) => name !== "build-manifest.json");
	const uncovered = actualTopLevel.filter((name) => !coveredTopLevel.has(name));
	if (uncovered.length > 0) {
		throw new Error(`AutoPi backend resources are missing from the integrity contract: ${uncovered.sort().join(", ")}`);
	}
}

export function resolveBundledBackend(
	extensionRoot: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): BundledBackendLaunch {
	const target = expectedTarget(platform, arch);
	const backendRoot = path.join(extensionRoot, "resources", "backend");
	const manifest = readManifest(path.join(backendRoot, "build-manifest.json"));
	if (manifest.platform !== target) {
		throw new Error(`AutoPi backend targets ${manifest.platform}, but this VS Code host requires ${target}`);
	}
	verifyIntegrity(backendRoot, manifest.integrity.entries);
	verifyIntegrityCoverage(backendRoot, manifest.integrity.entries);

	const executablePath = resolveInside(backendRoot, manifest.launch.executable);
	if (platform === "linux") {
		try {
			accessSync(executablePath, constants.X_OK);
		} catch {
			chmodSync(executablePath, statSync(executablePath).mode | 0o100);
			accessSync(executablePath, constants.X_OK);
		}
	}
	const executableArgs = manifest.launch.arguments.map((argument) => {
		if (argument.kind === "literal") return argument.value;
		return resolveInside(backendRoot, argument.path);
	});
	return { executablePath, executableArgs };
}
