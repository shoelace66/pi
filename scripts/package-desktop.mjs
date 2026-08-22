#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import {
	computeTreeDigest,
	DELIVERY_MANIFEST_JSON,
	DELIVERY_MANIFEST_TEXT,
	formatManifestText,
	sha256File,
	sha256Text,
	synchronizeDelivery,
	verifyDelivery,
} from "./desktop-release-lib.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDirectory = join(repoRoot, "apps", "desktop");
const artifactsDirectory = join(repoRoot, ".artifacts");
const packages = [
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

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function printUsage() {
	console.log(`Usage: node scripts/package-desktop.mjs [options]

Builds the AutoPi Windows x64 portable product, verifies the CLI and archive,
and optionally synchronizes the same build to a delivery directory.

Options:
  --out <dir>       Product directory (default: .artifacts/AutoPi-<version>-win-x64)
  --sync <dir>      Replace this directory with the verified product build
  --skip-build      Reuse existing core and desktop dist output
  --help            Show this help
`);
}

function parseArgs() {
	const options = { outDirectory: undefined, skipBuild: false, syncDirectory: undefined };
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--skip-build") {
			options.skipBuild = true;
			continue;
		}
		if (arg === "--out" || arg === "--sync") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a directory`);
			if (arg === "--out") options.outDirectory = value;
			else options.syncDirectory = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		env: options.env ?? process.env,
		shell: process.platform === "win32" && /\.cmd$/i.test(command),
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		windowsHide: true,
	});
	if (result.status !== 0) {
		const details = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
		throw new Error(`Command failed: ${[command, ...args].join(" ")}${details}`);
	}
	return result.stdout?.trim() ?? "";
}

function fileSpecifier(fromDirectory, file) {
	const path = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

function packPackage(pkg, tarballDirectory) {
	const directory = join(repoRoot, pkg.directory);
	const packageJson = readJson(join(directory, "package.json"));
	if (packageJson.name !== pkg.name) throw new Error(`${pkg.directory} has unexpected package name ${packageJson.name}`);
	const output = run(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["pack", "--json", "--pack-destination", tarballDirectory],
		{ capture: true, cwd: directory },
	);
	const parsed = JSON.parse(output);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	return join(tarballDirectory, packed.filename);
}

function findAsset(directory, pattern, label) {
	const name = readdirSync(directory).find((entry) => pattern.test(entry));
	if (!name) throw new Error(`${label} was not generated in ${directory}`);
	return join(directory, name);
}

function relativeProductPath(path, productDirectory) {
	return relative(productDirectory, path).replaceAll("\\", "/");
}

function writeCliLaunchers(productDirectory, coreCli, wakeCli) {
	const launcher = (entry) =>
		`@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0AutoPi.exe" "%~dp0${relativeProductPath(entry, productDirectory).replaceAll("/", "\\")}" %*\r\n`;
	writeFileSync(join(productDirectory, "autopi.cmd"), launcher(coreCli));
	writeFileSync(join(productDirectory, "pi.cmd"), launcher(coreCli));
	writeFileSync(join(productDirectory, "pi-wake.cmd"), launcher(wakeCli));
	writeFileSync(
		join(productDirectory, "README.txt"),
		`AutoPi portable product\r\n\r\nStart here (Chinese): START-HERE-开始使用.txt\r\nGUI: AutoPi.exe\r\nCLI: autopi.cmd (pi.cmd is also provided for compatibility)\r\nWake CLI: pi-wake.cmd\r\nBuild provenance: BUILD-MANIFEST.json\r\nProject: https://github.com/shoelace66/AutoPi\r\n`,
	);
}

function applyWindowsResources(executable, icon, version) {
	const image = NtExecutable.from(readFileSync(executable));
	const resources = NtExecutableResource.from(image);
	const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
	if (iconGroups.length !== 1) throw new Error("AutoPi executable has an unexpected Windows icon layout");
	const iconFile = Data.IconFile.from(readFileSync(icon));
	Resource.IconGroupEntry.replaceIconsForResource(
		resources.entries,
		iconGroups[0].id,
		iconGroups[0].lang,
		iconFile.icons.map((item) => item.data),
	);

	const versionInfo = Resource.VersionInfo.fromEntries(resources.entries);
	if (versionInfo.length !== 1) throw new Error("AutoPi executable has an unexpected version resource layout");
	const versionParts = version.split(".").map((part) => Number.parseInt(part, 10));
	versionInfo[0].setFileVersion(...versionParts);
	versionInfo[0].setProductVersion(...versionParts);
	const languages = versionInfo[0].getAllLanguagesForStringValues();
	if (languages.length !== 1) throw new Error("AutoPi executable has an unexpected resource language layout");
	versionInfo[0].setStringValues(languages[0], {
		CompanyName: "AutoPi",
		FileDescription: "AutoPi autonomous agent desktop",
		FileVersion: version,
		InternalName: "AutoPi",
		LegalCopyright: "Copyright AutoPi contributors. Pi components are MIT licensed.",
		OriginalFilename: "AutoPi.exe",
		ProductName: "AutoPi",
		ProductVersion: version,
	});
	versionInfo[0].outputToResourceEntries(resources.entries);
	resources.outputResource(image);
	writeFileSync(executable, Buffer.from(image.generate()));
}

function assembleElectronProduct(stage, output, icon, electronVersion) {
	const electronRuntime = join(repoRoot, "node_modules", "electron", "dist");
	const runtimeVersion = readFileSync(join(electronRuntime, "version"), "utf8").trim();
	if (runtimeVersion !== electronVersion) {
		throw new Error(`Installed Electron runtime is ${runtimeVersion}; expected ${electronVersion}`);
	}
	const packagedApp = join(output, "AutoPi-win32-x64");
	cpSync(electronRuntime, packagedApp, { recursive: true });
	const resources = join(packagedApp, "resources");
	rmSync(join(resources, "default_app.asar"), { force: true });
	rmSync(join(resources, "default_app"), { force: true, recursive: true });
	cpSync(stage, join(resources, "app"), { recursive: true });
	cpSync(join(repoRoot, "autopi-ap-symbol-1024.png"), join(resources, "autopi-ap-symbol-1024.png"));
	const executable = join(packagedApp, "AutoPi.exe");
	renameSync(join(packagedApp, "electron.exe"), executable);
	applyWindowsResources(executable, icon, desktopPackage.version);
	return [packagedApp];
}

function verifyCli(productDirectory, coreCli, wakeCli, expectedVersion) {
	const executable = join(productDirectory, "AutoPi.exe");
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	const version = run(executable, [coreCli, "--version"], { capture: true, env });
	if (!version.includes(expectedVersion)) throw new Error(`Packaged CLI reported unexpected version: ${version}`);
	const wakeHelp = run(executable, [wakeCli, "--help"], { capture: true, env });
	if (!wakeHelp.includes("pi-wake")) throw new Error("Packaged Wake CLI did not return its help output");
}

const options = parseArgs();
const desktopPackage = readJson(join(desktopDirectory, "package.json"));
const corePackage = readJson(join(repoRoot, "packages", "coding-agent", "package.json"));
const productDirectory = resolve(
	options.outDirectory ?? join(artifactsDirectory, `AutoPi-${desktopPackage.version}-win-x64`),
);
if (!isAbsolute(productDirectory)) throw new Error("Product output must resolve to an absolute path");
const archivePath = `${productDirectory}.zip`;
const workDirectory = join(artifactsDirectory, ".autopi-package-work");
const tarballDirectory = join(workDirectory, "tarballs");
const stageDirectory = join(workDirectory, "app");
const packagerOutput = join(workDirectory, "packager");
const verifyDirectory = join(workDirectory, "verify");
const generatedIcon = join(workDirectory, "autopi.ico");

if (process.platform !== "win32" || process.arch !== "x64") {
	throw new Error(`This release command currently targets Windows x64, received ${process.platform} ${process.arch}`);
}

if (!options.skipBuild) {
	run("npm.cmd", ["run", "build:offline"]);
	run("npm.cmd", ["run", "build:desktop"]);
}
if (!existsSync(join(desktopDirectory, "dist", "electron", "main.js"))) {
	throw new Error("Desktop build output is missing; run without --skip-build");
}

rmSync(workDirectory, { force: true, recursive: true });
rmSync(productDirectory, { force: true, recursive: true });
rmSync(archivePath, { force: true });
mkdirSync(tarballDirectory, { recursive: true });
mkdirSync(stageDirectory, { recursive: true });

const tarballs = new Map(packages.map((pkg) => [pkg.name, packPackage(pkg, tarballDirectory)]));
const workspacePackageHashes = Object.fromEntries(
	Array.from(tarballs, ([name, path]) => [name, sha256File(path)]),
);
const localPackages = Object.fromEntries(
	packages.map((pkg) => [pkg.name, fileSpecifier(stageDirectory, tarballs.get(pkg.name))]),
);
const stagePackage = {
	name: "autopi-desktop-product",
	productName: "AutoPi",
	private: true,
	version: desktopPackage.version,
	type: "module",
	main: "dist/electron/main.js",
	dependencies: { "@earendil-works/pi-coding-agent": localPackages["@earendil-works/pi-coding-agent"] },
	overrides: localPackages,
};
writeFileSync(join(stageDirectory, "package.json"), `${JSON.stringify(stagePackage, null, "\t")}\n`);
cpSync(join(desktopDirectory, "dist"), join(stageDirectory, "dist"), { recursive: true });
run("npm.cmd", ["install", "--omit=dev", "--ignore-scripts"], { cwd: stageDirectory });

const stageBuildInfoPath = join(stageDirectory, "dist", "build-info.json");
const buildInfo = readJson(stageBuildInfoPath);
const rendererAssets = join(stageDirectory, "dist", "renderer", "assets");
const componentPaths = {
	desktopMain: join(stageDirectory, "dist", "electron", "main.js"),
	rendererJavaScript: findAsset(rendererAssets, /^index-.*\.js$/, "Renderer JavaScript"),
	rendererCss: findAsset(rendererAssets, /^index-.*\.css$/, "Renderer CSS"),
	coreIndex: join(
		stageDirectory,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"index.js",
	),
};
const componentHashes = Object.fromEntries(
	Object.entries(componentPaths).map(([name, path]) => [name, sha256File(path)]),
);
const buildId = `autopi-${desktopPackage.version}-${sha256Text(
	JSON.stringify({
		productVersion: desktopPackage.version,
		coreVersion: corePackage.version,
		sourceRevision: buildInfo.sourceRevision,
		components: componentHashes,
		workspacePackages: workspacePackageHashes,
		releaseScript: sha256File(fileURLToPath(import.meta.url)),
	}),
).slice(0, 16).toLowerCase()}`;
writeFileSync(stageBuildInfoPath, `${JSON.stringify({ ...buildInfo, buildId }, null, "\t")}\n`);

run(
	"powershell.exe",
	[
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		join(repoRoot, "scripts", "create-windows-icon.ps1"),
		"-InputPng",
		join(repoRoot, "autopi-ap-symbol-1024.png"),
		"-OutputIco",
		generatedIcon,
	],
);

const outputPaths = assembleElectronProduct(
	stageDirectory,
	packagerOutput,
	generatedIcon,
	desktopPackage.devDependencies.electron,
);
if (outputPaths.length !== 1) throw new Error(`AutoPi assembly returned ${outputPaths.length} product paths`);
cpSync(outputPaths[0], productDirectory, { recursive: true });
cpSync(join(repoRoot, "LICENSE"), join(productDirectory, "LICENSE-AUTOPI.txt"));
cpSync(join(repoRoot, "docs", "START-HERE.zh-CN.txt"), join(productDirectory, "START-HERE-开始使用.txt"));
cpSync(join(repoRoot, "docs", "GETTING-STARTED.zh-CN.md"), join(productDirectory, "使用教程.md"));

const packagedCoreDirectory = join(
	productDirectory,
	"resources",
	"app",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
);
const packagedCoreCli = join(packagedCoreDirectory, "cli.js");
const packagedWakeCli = join(packagedCoreDirectory, "wake-cli.js");
writeCliLaunchers(productDirectory, packagedCoreCli, packagedWakeCli);
verifyCli(productDirectory, packagedCoreCli, packagedWakeCli, corePackage.version);

const manifestComponents = Object.fromEntries(
	Object.entries(componentPaths).map(([name, stagePath]) => {
		const appRelative = relative(stageDirectory, stagePath);
		const productPath = join(productDirectory, "resources", "app", appRelative);
		return [
			name,
			{ path: relativeProductPath(productPath, productDirectory), sha256: sha256File(productPath) },
		];
	}),
);
manifestComponents.executable = { path: "AutoPi.exe", sha256: sha256File(join(productDirectory, "AutoPi.exe")) };
const tree = computeTreeDigest(productDirectory);
const manifest = {
	schemaVersion: 1,
	productName: "AutoPi",
	productVersion: desktopPackage.version,
	coreVersion: corePackage.version,
	electronVersion: desktopPackage.devDependencies.electron,
	buildId,
	builtAt: buildInfo.builtAt,
	platform: "windows-x64",
	sourceRevision: buildInfo.sourceRevision,
	sourceDirty: buildInfo.sourceDirty,
	components: manifestComponents,
	workspacePackages: workspacePackageHashes,
	releaseScriptSha256: sha256File(fileURLToPath(import.meta.url)),
	tree,
};
writeFileSync(join(productDirectory, DELIVERY_MANIFEST_JSON), `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(join(productDirectory, DELIVERY_MANIFEST_TEXT), formatManifestText(manifest));

mkdirSync(verifyDirectory, { recursive: true });
run("tar.exe", ["-a", "-cf", archivePath, "-C", productDirectory, "."]);
run("tar.exe", ["-xf", archivePath, "-C", verifyDirectory]);
verifyDelivery(productDirectory, verifyDirectory);
const archiveHash = sha256File(archivePath);
writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${archivePath.split(/[\\/]/).at(-1)}\n`);

let synchronizedDirectory;
if (options.syncDirectory) {
	synchronizedDirectory = synchronizeDelivery(productDirectory, options.syncDirectory, repoRoot);
	verifyDelivery(productDirectory, synchronizedDirectory);
}

console.log("\nAutoPi product build complete");
console.log(`  Build ID: ${buildId}`);
console.log(`  Product:  ${productDirectory}`);
console.log(`  Archive:  ${archivePath}`);
console.log(`  SHA256:   ${archiveHash}`);
if (synchronizedDirectory) console.log(`  Synced:   ${synchronizedDirectory}`);
