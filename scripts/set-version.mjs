#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const target = process.argv[2];
if (target === "--help") {
	console.log("Usage: node scripts/set-version.mjs <version>");
	process.exit(0);
}
if (!target || target.startsWith("-")) {
	throw new Error("A version value is required");
}

function run(command, args) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: "inherit",
		shell: process.platform === "win32" && /\.cmd$/i.test(command),
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(npm, [
	"version",
	target,
	"--workspaces",
	"--include-workspace-root",
	"--no-git-tag-version",
	"--no-workspaces-update",
]);
run(process.execPath, ["scripts/sync-versions.js"]);
run(npm, ["install", "--package-lock-only", "--ignore-scripts"]);
