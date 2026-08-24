#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} from "@vscode/test-electron";
import { build } from "esbuild";
import { hostReleaseTarget } from "./release-targets.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = join(repoRoot, "apps", "vscode");
const extensionPackage = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
const integrationRoot = join(repoRoot, ".artifacts", "vscode", "integration");
mkdirSync(integrationRoot, { recursive: true });
const testRoot = mkdtempSync(join(integrationRoot, "run-"));
const workspaceRoot = join(testRoot, "workspace");
const projectA = join(workspaceRoot, "project-a");
const projectB = join(workspaceRoot, "project-b");
const profileRoot = join(testRoot, "profile");
const extensionsDirectory = join(profileRoot, "extensions");
const userDataDirectory = join(profileRoot, "user-data");
const runnerRoot = join(testRoot, "runner-extension");
const suitePath = join(runnerRoot, "suite.cjs");
const workspacePath = join(workspaceRoot, "autopi.code-workspace");

function printUsage() {
	console.log(`Usage: node scripts/run-vscode-integration.mjs [options]

Options:
  --vsix <path>    Install and test this VSIX in an isolated profile
  --development    Test apps/vscode as an extensionDevelopmentPath
  --help           Show this help

Without an explicit mode, the host-platform VSIX in .artifacts/vscode is used
when present; otherwise the development extension is tested.
`);
}

function parseArgs() {
	const args = process.argv.slice(2);
	let development = false;
	let vsixPath = process.env.AUTOPI_VSCODE_INTEGRATION_VSIX || undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help") {
			printUsage();
			process.exit(0);
		}
		if (argument === "--development") {
			development = true;
			continue;
		}
		if (argument === "--vsix") {
			vsixPath = args[++index];
			if (!vsixPath) throw new Error("--vsix requires a path");
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	if (development && vsixPath) throw new Error("--development and --vsix cannot be used together");
	if (development) return { mode: "development" };
	if (vsixPath) return { mode: "installed", vsixPath: isAbsolute(vsixPath) ? vsixPath : resolve(vsixPath) };

	const host = hostReleaseTarget();
	const expectedVsix = host
		? join(repoRoot, ".artifacts", "vscode", `AutoPi-${extensionPackage.version}-${host.name}.vsix`)
		: undefined;
	return expectedVsix && existsSync(expectedVsix)
		? { mode: "installed", vsixPath: expectedVsix }
		: { mode: "development" };
}

function run(command, args) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: "inherit",
		shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
}

const options = parseArgs();
if (options.mode === "installed" && !existsSync(options.vsixPath)) {
	throw new Error(`VSIX does not exist: ${options.vsixPath}`);
}

mkdirSync(join(projectA, "reports"), { recursive: true });
mkdirSync(projectB, { recursive: true });
mkdirSync(extensionsDirectory, { recursive: true });
mkdirSync(userDataDirectory, { recursive: true });
mkdirSync(runnerRoot, { recursive: true });
writeFileSync(join(projectA, "reports", "eval.md"), "# Evaluation\n\nIntegration fixture.\n");
writeFileSync(join(projectB, "README.md"), "# Project B\n");
writeFileSync(
	workspacePath,
	`${JSON.stringify(
		{
			folders: [{ path: "project-a" }, { path: "project-b" }],
			settings: { "security.workspace.trust.enabled": false },
		},
		null,
		"\t",
	)}\n`,
);
writeFileSync(
	join(runnerRoot, "package.json"),
	`${JSON.stringify(
		{
			name: "autopi-integration-test-runner",
			displayName: "AutoPi Integration Test Runner",
			publisher: "autopi-tests",
			version: "0.0.1",
			private: true,
			engines: { vscode: "^1.134.0" },
			main: "./extension.cjs",
			activationEvents: ["*"],
		},
		null,
		"\t",
	)}\n`,
);
writeFileSync(join(runnerRoot, "extension.cjs"), "exports.activate = function activate() {};\nexports.deactivate = function deactivate() {};\n");

await build({
	entryPoints: [join(extensionRoot, "test", "integration", "suite.ts")],
	outfile: suitePath,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	external: ["vscode"],
	logLevel: "info",
});

const vscodeExecutablePath = await downloadAndUnzipVSCode("1.134.0");
if (options.mode === "installed") {
	const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
		reuseMachineInstall: true,
	});
	run(cli, [
		...cliArgs,
		`--extensions-dir=${extensionsDirectory}`,
		`--user-data-dir=${userDataDirectory}`,
		"--install-extension",
		options.vsixPath,
		"--force",
	]);
}

console.log(
	options.mode === "installed"
		? `Running integration tests against installed VSIX: ${options.vsixPath}`
		: `Running integration tests against development extension: ${extensionRoot}`,
);
await runTests({
	vscodeExecutablePath,
	extensionDevelopmentPath: options.mode === "installed" ? runnerRoot : extensionRoot,
	extensionTestsPath: suitePath,
	launchArgs: [
		workspacePath,
		`--extensions-dir=${extensionsDirectory}`,
		`--user-data-dir=${userDataDirectory}`,
		...(options.mode === "installed" ? [] : ["--disable-extensions"]),
		"--disable-workspace-trust",
	],
	extensionTestsEnv: {
		AUTOPI_INTEGRATION_PROJECT_A: projectA,
		AUTOPI_INTEGRATION_EXPECT_INSTALLED: options.mode === "installed" ? "1" : "0",
		AUTOPI_INTEGRATION_EXTENSIONS_DIR: extensionsDirectory,
		AUTOPI_INTEGRATION_EXTENSION_VERSION: extensionPackage.version,
	},
});
