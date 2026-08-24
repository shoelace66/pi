#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getReleaseTarget, hostReleaseTarget, targetMatchesHost } from "./release-targets.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = join(repoRoot, "apps", "vscode");
const backendRoot = join(extensionRoot, "resources", "backend");
const artifactsRoot = join(repoRoot, ".artifacts", "vscode");
const extensionPackage = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const corePackage = JSON.parse(readFileSync(join(repoRoot, "packages", "coding-agent", "package.json"), "utf8"));
const runtimePackages = [
	{ directory: "packages/telemetry", name: "@earendil-works/pi-telemetry" },
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/protocol", name: "@earendil-works/pi-protocol" },
	{ directory: "packages/client", name: "@earendil-works/pi-client" },
	{ directory: "packages/session-backends/sqlite-node", name: "@earendil-works/pi-session-backend-sqlite-node" },
	{ directory: "packages/server", name: "@earendil-works/pi-server" },
	{ directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

function printUsage() {
	console.log(`Usage: node scripts/package-vscode.mjs [options]

Options:
  --target <name>  win32-x64 or linux-x64 (default: current supported host)
  --backend <kind> auto, bun, or node (default: auto)
  --skip-build     Reuse existing core and VS Code dist output
  --help           Show this help
`);
}

function parseArgs() {
	const args = process.argv.slice(2);
	let targetName;
	let backend = "auto";
	let skipBuild = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--skip-build") {
			skipBuild = true;
			continue;
		}
		if (arg === "--target") {
			targetName = args[++index];
			if (!targetName) throw new Error("--target requires a value");
			continue;
		}
		if (arg === "--backend") {
			backend = args[++index];
			if (!new Set(["auto", "bun", "node"]).has(backend)) {
				throw new Error("--backend must be auto, bun, or node");
			}
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	const host = hostReleaseTarget();
	if (!targetName && !host) throw new Error(`No default VSIX target for ${process.platform} ${process.arch}`);
	return { target: getReleaseTarget(targetName ?? host.name), backend, skipBuild };
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		input: options.input,
		maxBuffer: options.capture ? 32 * 1024 * 1024 : undefined,
		stdio: options.capture ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit",
		shell: process.platform === "win32" && /\.cmd$/i.test(command),
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
	return result.stdout?.trim() ?? "";
}

function copyRequired(source, destination) {
	if (!existsSync(source)) throw new Error(`Required backend asset is missing: ${source}`);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: statSync(source).isDirectory(), dereference: true });
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalRelativePath(root, pathname) {
	return relative(root, pathname).replaceAll("\\", "/");
}

function comparePath(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function treeFiles(root) {
	const files = [];
	const visit = (directory) => {
		for (const name of readdirSync(directory).sort(comparePath)) {
			const absolutePath = join(directory, name);
			const metadata = lstatSync(absolutePath);
			if (metadata.isSymbolicLink()) {
				throw new Error(`Backend integrity trees cannot contain symbolic links: ${absolutePath}`);
			}
			if (metadata.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!metadata.isFile()) throw new Error(`Unsupported backend runtime entry: ${absolutePath}`);
			files.push({ absolutePath, relativePath: canonicalRelativePath(root, absolutePath), size: metadata.size });
		}
	};
	visit(root);
	return files.sort((left, right) => comparePath(left.relativePath, right.relativePath));
}

function treeIntegrityEntry(pathname) {
	const digest = createHash("sha256");
	let totalBytes = 0;
	const files = treeFiles(pathname);
	for (const file of files) {
		const fileHash = sha256File(file.absolutePath);
		digest.update(`${file.relativePath}\0${file.size}\0${fileHash}\n`, "utf8");
		totalBytes += file.size;
	}
	return {
		kind: "tree",
		path: canonicalRelativePath(backendRoot, pathname),
		sha256: digest.digest("hex"),
		fileCount: files.length,
		totalBytes,
	};
}

function fileIntegrityEntry(pathname) {
	return {
		kind: "file",
		path: canonicalRelativePath(backendRoot, pathname),
		sha256: sha256File(pathname),
		size: statSync(pathname).size,
	};
}

function materializeLaunchArguments(launch) {
	return launch.arguments.map((argument) => (argument.kind === "resource" ? argument.path : argument.value));
}

function findBunExecutable() {
	const host = hostReleaseTarget();
	if (!host) return process.platform === "win32" ? "bun.exe" : "bun";
	const name = process.platform === "win32" ? "bun.exe" : "bun";
	const candidates = [
		join(repoRoot, "node_modules", "@oven", host.bunHostPackage, "bin", name),
		join(repoRoot, "node_modules", "bun", "bin", name),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

function fileSpecifier(fromDirectory, file) {
	const path = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

function packPackage(pkg, tarballDirectory) {
	const directory = join(repoRoot, pkg.directory);
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (packageJson.name !== pkg.name) throw new Error(`${pkg.directory} has unexpected package name ${packageJson.name}`);
	const output = run(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["pack", "--json", "--pack-destination", tarballDirectory],
		{ capture: true, cwd: directory },
	);
	const parsed = JSON.parse(output);
	return join(tarballDirectory, parsed[0].filename);
}

function assembleNodeFallback(target, workRoot) {
	if (!targetMatchesHost(target)) {
		throw new Error(
			`Bun is unavailable and a bundled Node fallback cannot be cross-packaged for ${target.name} from ${process.platform}-${process.arch}`,
		);
	}
	const stageRoot = join(workRoot, "node-runtime");
	const tarballDirectory = join(stageRoot, "tarballs");
	const appDirectory = join(stageRoot, "app");
	mkdirSync(tarballDirectory, { recursive: true });
	mkdirSync(appDirectory, { recursive: true });
	const tarballs = new Map(runtimePackages.map((pkg) => [pkg.name, packPackage(pkg, tarballDirectory)]));
	const localPackages = Object.fromEntries(
		runtimePackages.map((pkg) => [pkg.name, fileSpecifier(appDirectory, tarballs.get(pkg.name))]),
	);
	writeFileSync(
		join(appDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "autopi-vscode-backend-runtime",
				private: true,
				version: extensionPackage.version,
				type: "module",
				dependencies: { "@earendil-works/pi-coding-agent": localPackages["@earendil-works/pi-coding-agent"] },
				overrides: localPackages,
			},
			null,
			"\t",
		)}\n`,
	);
	run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts"], {
		cwd: appDirectory,
	});
	const runtimeRoot = join(backendRoot, "runtime");
	copyRequired(process.execPath, join(backendRoot, target.nodeExecutableName));
	copyRequired(join(appDirectory, "node_modules"), join(runtimeRoot, "node_modules"));
	// copy-binary-assets places a package.json beside Bun's compiled layout. It
	// must never shadow the real package root in a subsequently packed Node CLI.
	rmSync(
		join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "package.json"),
		{ force: true },
	);
	let removedFiles = 0;
	const pruneDevelopmentFiles = (directory) => {
		for (const name of readdirSync(directory)) {
			const pathname = join(directory, name);
			const metadata = lstatSync(pathname);
			if (metadata.isDirectory()) {
				pruneDevelopmentFiles(pathname);
				continue;
			}
			if (/\.map$/i.test(name) || /\.d\.(?:ts|mts|cts)$/i.test(name)) {
				rmSync(pathname, { force: true });
				removedFiles++;
			}
		}
	};
	pruneDevelopmentFiles(runtimeRoot);
	console.log(`Removed ${removedFiles} declaration and source-map files from the bundled-Node runtime.`);
	return {
		executable: join(backendRoot, target.nodeExecutableName),
		arguments: [
			{
				kind: "resource",
				role: "cli-entrypoint",
				path: join(
				runtimeRoot,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"cli.js",
			),
			},
		],
		runtimeRoot,
		backendKind: "bundled-node",
	};
}

function clipboardRoots(target, workRoot) {
	const generic = join(repoRoot, "node_modules", "@mariozechner", "clipboard");
	const native = join(repoRoot, "node_modules", "@mariozechner", target.clipboardPackage);
	if (existsSync(generic) && existsSync(native)) return { generic, native };
	const dependencyRoot = join(workRoot, "native-dependencies");
	mkdirSync(dependencyRoot, { recursive: true });
	writeFileSync(join(dependencyRoot, "package.json"), '{"private":true}\n');
	const version = corePackage.optionalDependencies["@mariozechner/clipboard"];
	run(process.platform === "win32" ? "npm.cmd" : "npm", [
		"install",
		"--prefix",
		dependencyRoot,
		"--include=optional",
		"--no-save",
		"--package-lock=false",
		"--force",
		"--ignore-scripts",
		`@mariozechner/clipboard@${version}`,
		`@mariozechner/${target.clipboardPackage}@${version}`,
	]);
	return {
		generic: join(dependencyRoot, "node_modules", "@mariozechner", "clipboard"),
		native: join(dependencyRoot, "node_modules", "@mariozechner", target.clipboardPackage),
	};
}

function compileExecutablePath(target, workRoot) {
	const executableName = target.platform === "win32" ? "bun.exe" : "bun";
	const installed = join(
		repoRoot,
		"node_modules",
		"@oven",
		target.bunRuntimePackage,
		"bin",
		executableName,
	);
	if (existsSync(installed)) return installed;
	const dependencyRoot = join(workRoot, "compile-runtime");
	mkdirSync(dependencyRoot, { recursive: true });
	writeFileSync(join(dependencyRoot, "package.json"), '{"private":true}\n');
	run(process.platform === "win32" ? "npm.cmd" : "npm", [
		"install",
		"--prefix",
		dependencyRoot,
		"--no-save",
		"--package-lock=false",
		"--force",
		"--ignore-scripts",
		`@oven/${target.bunRuntimePackage}@${rootPackage.devDependencies.bun}`,
	]);
	return join(dependencyRoot, "node_modules", "@oven", target.bunRuntimePackage, "bin", executableName);
}

function copyBackendAssets(target, clipboard) {
	const coreRoot = join(repoRoot, "packages", "coding-agent");
	copyRequired(join(coreRoot, "package.json"), join(backendRoot, "package.json"));
	copyRequired(join(coreRoot, "README.md"), join(backendRoot, "README.md"));
	copyRequired(join(coreRoot, "CHANGELOG.md"), join(backendRoot, "CHANGELOG.md"));
	copyRequired(
		join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
		join(backendRoot, "photon_rs_bg.wasm"),
	);
	copyRequired(join(coreRoot, "dist", "modes", "interactive", "theme"), join(backendRoot, "theme"));
	copyRequired(join(coreRoot, "dist", "modes", "interactive", "assets"), join(backendRoot, "assets"));
	copyRequired(join(coreRoot, "dist", "core", "export-html"), join(backendRoot, "export-html"));
	copyRequired(clipboard.generic, join(backendRoot, "node_modules", "@mariozechner", "clipboard"));
	copyRequired(clipboard.native, join(backendRoot, "node_modules", "@mariozechner", target.clipboardPackage));
	copyRequired(
		join(clipboard.native, target.clipboardFile),
		join(backendRoot, "node_modules", "@mariozechner", "clipboard", target.clipboardFile),
	);
	if (target.platform === "win32") {
		copyRequired(
			join(repoRoot, "packages", "tui", "native", "win32", "prebuilds", "win32-x64", "win32-console-mode.node"),
			join(backendRoot, "native", "win32", "prebuilds", "win32-x64", "win32-console-mode.node"),
		);
	}
}

if (extensionPackage.autopiCoreVersion !== corePackage.version) {
	throw new Error(
		`VS Code extension expects AutoPi core ${extensionPackage.autopiCoreVersion}; repository core is ${corePackage.version}`,
	);
}
if (extensionPackage.version !== corePackage.version) {
	throw new Error(
		`VS Code extension version ${extensionPackage.version} must stay in lockstep with AutoPi core ${corePackage.version}`,
	);
}
const options = parseArgs();
const target = options.target;
const artifactName = `AutoPi-${extensionPackage.version}-${target.name}.vsix`;
const artifactPath = join(artifactsRoot, artifactName);
const workRoot = join(artifactsRoot, `.package-work-${target.name}`);

if (!options.skipBuild) {
	run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:offline"]);
	run(process.execPath, [join(repoRoot, "scripts", "build-vscode.mjs")]);
}
if (!existsSync(join(extensionRoot, "dist", "extension.js"))) {
	throw new Error("VS Code build output is missing; run without --skip-build");
}

rmSync(backendRoot, { recursive: true, force: true });
rmSync(workRoot, { recursive: true, force: true });
rmSync(artifactPath, { force: true });
rmSync(`${artifactPath}.sha256`, { force: true });
mkdirSync(backendRoot, { recursive: true });
mkdirSync(artifactsRoot, { recursive: true });
mkdirSync(workRoot, { recursive: true });

const bunExecutable = findBunExecutable();
const bunProbe = spawnSync(bunExecutable, ["--version"], { encoding: "utf8", windowsHide: true });
let launch;
if (options.backend === "bun" && bunProbe.status !== 0) {
	throw new Error(`The requested Bun backend compiler is unavailable: ${bunExecutable}`);
}
if (options.backend !== "node" && bunProbe.status === 0) {
	const backendExecutable = join(backendRoot, target.executableName);
	const compileRuntime = compileExecutablePath(target, workRoot);
	run(bunExecutable, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--compile-executable-path",
		compileRuntime,
		`--target=${target.bunTarget}`,
		join(repoRoot, "packages", "coding-agent", "dist", "bun", "cli.js"),
		join(repoRoot, "packages", "coding-agent", "src", "utils", "image-resize-worker.ts"),
		"--outfile",
		backendExecutable,
	]);
	launch = { executable: backendExecutable, arguments: [], backendKind: "bun-compiled" };
} else {
	console.warn(
		options.backend === "node"
			? "Packaging the explicitly requested platform-matched bundled-Node backend."
			: "Bun is unavailable; packaging the platform-matched bundled-Node fallback.",
	);
	launch = assembleNodeFallback(target, workRoot);
}

copyBackendAssets(target, clipboardRoots(target, workRoot));
if (target.platform === "linux") chmodSync(launch.executable, 0o700);

let runtimeVerifiedOnTarget = false;
if (targetMatchesHost(target)) {
	const launchArguments = materializeLaunchArguments(launch);
	const backendVersion = run(launch.executable, [...launchArguments, "--version"], { capture: true });
	if (!backendVersion.includes(corePackage.version)) {
		throw new Error(`Packaged backend reported unexpected version: ${backendVersion}`);
	}
	const rpcOutput = run(launch.executable, [...launchArguments, "--mode", "rpc", "--no-session", "--offline"], {
		capture: true,
		input: '{"type":"get_state","id":"vscode-package-smoke"}\n',
	});
	if (!rpcOutput.includes('"type":"rpc_ready"')) throw new Error("Packaged backend did not emit rpc_ready");
	runtimeVerifiedOnTarget = true;
}

const sourceRevision = run("git", ["rev-parse", "HEAD"], { capture: true });
const sourceDirty = run("git", ["status", "--porcelain"], { capture: true }).length > 0;
const manifestLaunch = {
	executable: canonicalRelativePath(backendRoot, launch.executable),
	arguments: launch.arguments.map((argument) =>
		argument.kind === "resource"
			? {
					kind: "resource",
					path: canonicalRelativePath(backendRoot, argument.path),
					...(argument.role ? { role: argument.role } : {}),
				}
			: { kind: "literal", value: argument.value },
	),
	...(launch.runtimeRoot ? { runtimeRoot: canonicalRelativePath(backendRoot, launch.runtimeRoot) } : {}),
};
const integrityEntriesByKey = new Map();
for (const pathname of [
	launch.executable,
	...launch.arguments.filter((argument) => argument.kind === "resource").map((argument) => argument.path),
]) {
	const entry = fileIntegrityEntry(pathname);
	integrityEntriesByKey.set(`${entry.kind}:${entry.path}`, entry);
}
if (launch.runtimeRoot) {
	const entry = treeIntegrityEntry(launch.runtimeRoot);
	integrityEntriesByKey.set(`${entry.kind}:${entry.path}`, entry);
}
for (const name of readdirSync(backendRoot).sort(comparePath)) {
	if (name === "build-manifest.json") continue;
	const pathname = join(backendRoot, name);
	const metadata = lstatSync(pathname);
	const entry = metadata.isDirectory() ? treeIntegrityEntry(pathname) : fileIntegrityEntry(pathname);
	integrityEntriesByKey.set(`${entry.kind}:${entry.path}`, entry);
}
const integrityEntries = [...integrityEntriesByKey.values()].sort((left, right) =>
	comparePath(`${left.kind}:${left.path}`, `${right.kind}:${right.path}`),
);
writeFileSync(
	join(backendRoot, "build-manifest.json"),
	`${JSON.stringify(
		{
			schemaVersion: 2,
			product: "AutoPi VS Code",
			extensionVersion: extensionPackage.version,
			coreVersion: corePackage.version,
			platform: target.name,
			backendKind: launch.backendKind,
			launch: manifestLaunch,
			integrity: {
				algorithm: "sha256",
				entries: integrityEntries,
			},
			runtimeVerifiedOnTarget,
			sourceRevision,
			sourceDirty,
			builtAt: new Date().toISOString(),
		},
		null,
		"\t",
	)}\n`,
);

const vsce = join(repoRoot, "node_modules", "@vscode", "vsce", "vsce");
if (!existsSync(vsce)) throw new Error("@vscode/vsce is not installed. Run npm install before packaging the VSIX.");
run(process.execPath, [vsce, "package", "--target", target.name, "--no-dependencies", "--out", artifactPath], {
	cwd: extensionRoot,
});

const archiveListCommand = process.platform === "win32" ? "tar.exe" : "unzip";
const archiveListArgs = process.platform === "win32" ? ["-tf", artifactPath] : ["-Z1", artifactPath];
const packagedFiles = run(archiveListCommand, archiveListArgs, { capture: true });
for (const required of [
	"extension/package.json",
	"extension/dist/extension.js",
	"extension/dist/webview/main.js",
	"extension/resources/backend/build-manifest.json",
	`extension/resources/backend/${manifestLaunch.executable}`,
	...manifestLaunch.arguments
		.filter((argument) => argument.kind === "resource")
		.map((argument) => `extension/resources/backend/${argument.path}`),
	`extension/resources/backend/node_modules/@mariozechner/clipboard/${target.clipboardFile}`,
]) {
	if (!packagedFiles.includes(required)) throw new Error(`VSIX is missing required file: ${required}`);
}
const forbidden =
	target.platform === "linux"
		? [/\.exe$/im, /clipboard-win32/im, /resources\/backend\/native\/win32/im]
		: [/clipboard-linux/im];
if (launch.backendKind === "bundled-node") {
	forbidden.push(
		/resources\/backend\/runtime\/node_modules\/.*\.map$/im,
		/resources\/backend\/runtime\/node_modules\/.*\.d\.(?:ts|mts|cts)$/im,
	);
}
for (const pattern of forbidden) {
	if (pattern.test(packagedFiles)) throw new Error(`VSIX contains an asset forbidden for ${target.name}: ${pattern}`);
}

const hash = sha256File(artifactPath);
writeFileSync(`${artifactPath}.sha256`, `${hash}  ${artifactName}\n`);
rmSync(workRoot, { recursive: true, force: true });
console.log("\nAutoPi VS Code package complete");
console.log(`  Target: ${target.name}`);
console.log(`  VSIX:   ${artifactPath}`);
console.log(`  SHA256: ${hash}`);
