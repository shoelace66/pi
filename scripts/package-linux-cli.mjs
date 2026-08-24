#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { computeTreeDigest, sha256File, sha256Text } from "./desktop-release-lib.mjs";
import { getReleaseTarget, hostReleaseTarget, targetMatchesHost } from "./release-targets.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreRoot = join(repoRoot, "packages", "coding-agent");
const artifactsRoot = join(repoRoot, ".artifacts", "cli");
const target = getReleaseTarget("linux-x64");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const corePackage = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"));
const productName = `AutoPi-${corePackage.version}-linux-x64`;
const productRoot = join(artifactsRoot, productName);
const archivePath = `${productRoot}.tar.gz`;
const workRoot = join(artifactsRoot, ".package-work-linux-x64");

function parseArgs() {
	const options = { skipBuild: false };
	for (const arg of process.argv.slice(2)) {
		if (arg === "--skip-build") options.skipBuild = true;
		else if (arg === "--help") {
			console.log("Usage: node scripts/package-linux-cli.mjs [--skip-build]");
			process.exit(0);
		} else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
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
	if (!existsSync(source)) throw new Error(`Required CLI asset is missing: ${source}`);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: statSync(source).isDirectory() });
}

function findBunExecutable() {
	const host = hostReleaseTarget();
	if (!host) throw new Error(`Building AutoPi binaries is unsupported on ${process.platform} ${process.arch}`);
	const executable = process.platform === "win32" ? "bun.exe" : "bun";
	const candidates = [
		join(repoRoot, "node_modules", "@oven", host.bunHostPackage, "bin", executable),
		join(repoRoot, "node_modules", "bun", "bin", executable),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? executable;
}

function findArchiveTarExecutable() {
	if (process.platform !== "win32") return "tar";
	const candidates = [
		process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "usr", "bin", "tar.exe") : undefined,
		process.env["ProgramFiles(x86)"]
			? join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "tar.exe")
			: undefined,
	];
	const gitLocation = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
		.stdout?.trim()
		.split(/\r?\n/)[0];
	if (gitLocation) candidates.push(join(dirname(dirname(gitLocation)), "usr", "bin", "tar.exe"));
	const executable = candidates.find((candidate) => candidate && existsSync(candidate));
	if (!executable) throw new Error("GNU tar from Git for Windows is required to preserve Linux execute permissions");
	return executable;
}

async function createLinuxArchive() {
	const tar = findArchiveTarExecutable();
	const uncompressedArchive = join(workRoot, `${productName}.tar`);
	run(tar, [
		"-cf",
		uncompressedArchive,
		"--force-local",
		"--format=pax",
		"--mode=u+rwX,go+rX,go-w",
		"--exclude=./autopi",
		"--exclude=./pi",
		"--exclude=./pi-wake",
		".",
	], { cwd: productRoot });
	run(tar, [
		"-rf",
		uncompressedArchive,
		"--force-local",
		"--mode=0755",
		"./autopi",
		"./pi",
		"./pi-wake",
	], { cwd: productRoot });
	await pipeline(createReadStream(uncompressedArchive), createGzip({ level: 9 }), createWriteStream(archivePath));
	rmSync(uncompressedArchive, { force: true });
	return run(process.platform === "win32" ? "tar.exe" : tar, ["-tzf", archivePath], { capture: true });
}

function clipboardRoots() {
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

function compileExecutablePath() {
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

function relativeProductPath(path) {
	return relative(productRoot, path).replaceAll("\\", "/");
}

const options = parseArgs();
if (!options.skipBuild) run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:offline"]);
for (const required of ["dist/bun/cli.js", "dist/wake-cli.js", "dist/modes/interactive/theme"]) {
	if (!existsSync(join(coreRoot, required))) throw new Error(`Core build output is missing: ${required}`);
}

rmSync(workRoot, { force: true, recursive: true });
rmSync(productRoot, { force: true, recursive: true });
rmSync(archivePath, { force: true });
rmSync(`${archivePath}.sha256`, { force: true });
mkdirSync(workRoot, { recursive: true });
mkdirSync(productRoot, { recursive: true });

const bun = findBunExecutable();
const compileRuntime = compileExecutablePath();
run(bun, [
	"build",
	"--compile",
	"--no-compile-autoload-bunfig",
	"--compile-executable-path",
	compileRuntime,
	`--target=${target.bunTarget}`,
	join(coreRoot, "dist", "bun", "cli.js"),
	join(coreRoot, "src", "utils", "image-resize-worker.ts"),
	"--outfile",
	join(productRoot, "autopi"),
]);
run(bun, [
	"build",
	"--compile",
	"--no-compile-autoload-bunfig",
	"--compile-executable-path",
	compileRuntime,
	`--target=${target.bunTarget}`,
	join(coreRoot, "dist", "wake-cli.js"),
	"--outfile",
	join(productRoot, "pi-wake"),
]);
cpSync(join(productRoot, "autopi"), join(productRoot, "pi"));
for (const executable of ["autopi", "pi", "pi-wake"]) {
	try {
		chmodSync(join(productRoot, executable), 0o755);
	} catch {
		// Windows cannot represent POSIX execute bits; the official Ubuntu build records them in the tarball.
	}
}

copyRequired(join(coreRoot, "package.json"), join(productRoot, "package.json"));
copyRequired(join(coreRoot, "README.md"), join(productRoot, "CORE-README.md"));
copyRequired(join(repoRoot, "LICENSE"), join(productRoot, "LICENSE"));
copyRequired(join(repoRoot, "docs", "LINUX-GETTING-STARTED.en.md"), join(productRoot, "GETTING-STARTED.en.md"));
copyRequired(join(repoRoot, "docs", "LINUX-GETTING-STARTED.zh-CN.md"), join(productRoot, "GETTING-STARTED.zh-CN.md"));
copyRequired(join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"), join(productRoot, "photon_rs_bg.wasm"));
copyRequired(join(coreRoot, "dist", "modes", "interactive", "theme"), join(productRoot, "theme"));
copyRequired(join(coreRoot, "dist", "modes", "interactive", "assets"), join(productRoot, "assets"));
copyRequired(join(coreRoot, "dist", "core", "export-html"), join(productRoot, "export-html"));

const clipboard = clipboardRoots();
copyRequired(clipboard.generic, join(productRoot, "node_modules", "@mariozechner", "clipboard"));
copyRequired(clipboard.native, join(productRoot, "node_modules", "@mariozechner", target.clipboardPackage));
copyRequired(
	join(clipboard.native, target.clipboardFile),
	join(productRoot, "node_modules", "@mariozechner", "clipboard", target.clipboardFile),
);

if (targetMatchesHost(target)) {
	const version = run(join(productRoot, "autopi"), ["--version"], { capture: true });
	if (!version.includes(corePackage.version)) throw new Error(`Linux CLI reported unexpected version: ${version}`);
	const wakeHelp = run(join(productRoot, "pi-wake"), ["--help"], { capture: true });
	if (!wakeHelp.includes("pi-wake emit")) throw new Error("Linux Wake CLI did not return its help output");
	const rpcOutput = run(join(productRoot, "autopi"), ["--mode", "rpc"], {
		capture: true,
		input: '{"type":"get_state","id":"linux-package-smoke"}\n',
	});
	if (!rpcOutput.includes('"type":"rpc_ready"')) throw new Error("Linux CLI did not emit the RPC ready handshake");
}

const sourceRevision = run("git", ["rev-parse", "HEAD"], { capture: true });
const sourceDirty = run("git", ["status", "--porcelain"], { capture: true }).length > 0;
const components = Object.fromEntries(
	[
		["cli", join(productRoot, "autopi")],
		["compatibilityCli", join(productRoot, "pi")],
		["wakeCli", join(productRoot, "pi-wake")],
		["clipboard", join(productRoot, "node_modules", "@mariozechner", "clipboard", target.clipboardFile)],
		["imageRuntime", join(productRoot, "photon_rs_bg.wasm")],
	].map(([name, path]) => [name, { path: relativeProductPath(path), sha256: sha256File(path) }]),
);
const builtAt = new Date().toISOString();
const buildId = `autopi-cli-${corePackage.version}-${sha256Text(
	JSON.stringify({ coreVersion: corePackage.version, sourceRevision, target: target.name, components }),
).slice(0, 16).toLowerCase()}`;
const tree = computeTreeDigest(productRoot);
const manifest = {
	schemaVersion: 1,
	product: "AutoPi CLI",
	productVersion: corePackage.version,
	coreVersion: corePackage.version,
	platform: target.name,
	buildId,
	builtAt,
	sourceRevision,
	sourceDirty,
	components,
	tree,
};
writeFileSync(join(productRoot, "BUILD-MANIFEST.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(
	join(productRoot, "BUILD-MANIFEST.txt"),
	`AutoPi CLI build\n\nBuild ID: ${buildId}\nPlatform: ${target.name}\nVersion: ${corePackage.version}\nSource revision: ${sourceRevision}${sourceDirty ? " (dirty working tree)" : ""}\nProduct tree: ${tree.fileCount} files\nProduct tree SHA256: ${tree.sha256}\n`,
);
const verifiedTree = computeTreeDigest(productRoot);
if (verifiedTree.fileCount !== tree.fileCount || verifiedTree.sha256 !== tree.sha256) {
	throw new Error("AutoPi CLI product does not match its build manifest");
}

const archiveList = await createLinuxArchive();
for (const required of ["autopi", "pi", "pi-wake", "BUILD-MANIFEST.json", target.clipboardFile]) {
	if (!archiveList.includes(required)) throw new Error(`Linux CLI archive is missing required file: ${required}`);
}
const archiveHash = sha256File(archivePath);
writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${productName}.tar.gz\n`);

console.log("\nAutoPi Linux CLI package complete");
console.log(`  Product: ${productRoot}`);
console.log(`  Archive: ${archivePath}`);
console.log(`  SHA256:  ${archiveHash}`);
