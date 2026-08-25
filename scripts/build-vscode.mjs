#!/usr/bin/env node

import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = join(repoRoot, "apps", "vscode");
const distRoot = join(extensionRoot, "dist");

await rm(distRoot, { recursive: true, force: true });
await mkdir(join(distRoot, "webview"), { recursive: true });
await mkdir(join(extensionRoot, "media"), { recursive: true });

await Promise.all([
	build({
		entryPoints: [join(extensionRoot, "src", "extension.ts")],
		outfile: join(distRoot, "extension.js"),
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node18",
		external: ["vscode"],
		logLevel: "info",
		sourcemap: false,
	}),
	build({
		entryPoints: [join(extensionRoot, "webview", "main.ts")],
		outfile: join(distRoot, "webview", "main.js"),
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "es2022",
		logLevel: "info",
		sourcemap: false,
	}),
	copyFile(join(extensionRoot, "webview", "styles.css"), join(distRoot, "webview", "styles.css")),
	copyFile(join(repoRoot, "autopi-ap-symbol-1024.png"), join(extensionRoot, "media", "symbol-dark.png")),
	copyFile(join(repoRoot, "autopi-ap-symbol-light-1024.png"), join(extensionRoot, "media", "symbol-light.png")),
	copyFile(join(repoRoot, "autopi-ap-symbol-1024.png"), join(extensionRoot, "media", "extension-icon.png")),
]);

console.log(`AutoPi VS Code extension bundle: ${distRoot}`);
