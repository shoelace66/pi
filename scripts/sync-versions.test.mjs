import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));
const rootManifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const releaseScriptPath = fileURLToPath(new URL("./release.mjs", import.meta.url));
const setVersionScriptPath = fileURLToPath(new URL("./set-version.mjs", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages"), join(root, "apps")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes private dependencies without touching registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@earendil-works/pi-coding-agent",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@earendil-works/pi-coding-agent": "^1.0.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@earendil-works/pi-coding-agent": "^1.0.0",
			},
		});
		await writeManifest(root, "apps/vscode", {
			name: "autopi",
			version: "0.1.0",
			private: true,
			autopiCoreVersion: "1.0.0",
		});
		await writeManifest(root, "apps/vscode/resources/backend", {
			name: "@earendil-works/pi-coding-agent",
			version: "1.0.0",
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@earendil-works/pi-coding-agent"], "^2.0.0");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@earendil-works/pi-coding-agent"], "^1.0.0");
		const vscodeManifest = await readManifest(root, "apps/vscode");
		assert.equal(vscodeManifest.version, "2.0.0");
		assert.equal(vscodeManifest.autopiCoreVersion, "2.0.0");
		const generatedBackendManifest = await readManifest(root, "apps/vscode/resources/backend");
		assert.equal(generatedBackendManifest.version, "1.0.0");

		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace version scripts include the private repository root", async () => {
	const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
	for (const scriptName of ["version:patch", "version:minor", "version:major"]) {
		assert.match(rootManifest.scripts[scriptName], /(?:^|\s)--include-workspace-root(?:\s|$)/);
	}
	assert.equal(rootManifest.scripts["version:set"], "node scripts/set-version.mjs");
});

test("the explicit release path includes the repository root and application changelogs", async () => {
	const releaseScript = await readFile(releaseScriptPath, "utf8");
	const setVersionScript = await readFile(setVersionScriptPath, "utf8");
	assert.match(releaseScript, /npm run version:set -- \$\{target\}/);
	assert.match(setVersionScript, /"--include-workspace-root"/);
	assert.match(setVersionScript, /scripts\/sync-versions\.js/);
	assert.match(releaseScript, /findPackageDirectories\("apps"\)/);
});
