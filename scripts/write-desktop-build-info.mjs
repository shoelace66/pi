#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function gitOutput(args, fallback) {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
	} catch {
		return fallback;
	}
}

function buildTimestamp() {
	const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
	return Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0
		? new Date(sourceDateEpoch * 1_000).toISOString()
		: new Date().toISOString();
}

const desktopPackage = readJson(join(repoRoot, "apps", "desktop", "package.json"));
const corePackage = readJson(join(repoRoot, "packages", "coding-agent", "package.json"));
const buildInfo = {
	schemaVersion: 1,
	productName: desktopPackage.productName,
	productVersion: desktopPackage.version,
	coreVersion: corePackage.version,
	electronVersion: desktopPackage.devDependencies.electron,
	builtAt: buildTimestamp(),
	sourceRevision: gitOutput(["rev-parse", "--short=12", "HEAD"], "unknown"),
	sourceDirty: gitOutput(["status", "--porcelain", "--untracked-files=normal"], "dirty") !== "",
	buildId: "development",
};
const outputPath = join(repoRoot, "apps", "desktop", "dist", "build-info.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, "\t")}\n`);
console.log(`Wrote ${outputPath}`);
