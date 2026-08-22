import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve } from "node:path";

export const DELIVERY_MANIFEST_JSON = "BUILD-MANIFEST.json";
export const DELIVERY_MANIFEST_TEXT = "BUILD-MANIFEST.txt";

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

export function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function collectFiles(root, directory, excludedNames, result) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (excludedNames.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) collectFiles(root, path, excludedNames, result);
		else if (entry.isFile()) result.push(relative(root, path).replaceAll("\\", "/"));
	}
}

export function computeTreeDigest(root, excludedNames = new Set([DELIVERY_MANIFEST_JSON, DELIVERY_MANIFEST_TEXT])) {
	const files = [];
	collectFiles(root, root, excludedNames, files);
	files.sort((left, right) => left.localeCompare(right));
	const records = files.map((file) => `${file}\0${sha256File(join(root, file))}`);
	return { fileCount: files.length, sha256: sha256Text(records.join("\n")) };
}

export function assertSafeSyncTarget(target, repoRoot) {
	if (!isAbsolute(target)) throw new Error(`Delivery target must be absolute: ${target}`);
	const resolved = resolve(target);
	const parsed = parse(resolved);
	const forbidden = [resolve(parsed.root), resolve(homedir()), resolve(repoRoot)];
	if (forbidden.some((path) => path.toLowerCase() === resolved.toLowerCase())) {
		throw new Error(`Refusing to replace unsafe delivery target: ${resolved}`);
	}
	const repoRelative = relative(resolved, resolve(repoRoot));
	if (repoRelative === "" || (!repoRelative.startsWith("..") && !isAbsolute(repoRelative))) {
		throw new Error(`Delivery target must not contain the repository: ${resolved}`);
	}
	if (!basename(resolved)) throw new Error(`Delivery target must name a directory: ${resolved}`);
	return resolved;
}

export function synchronizeDelivery(source, target, repoRoot) {
	if (!existsSync(source)) throw new Error(`Packaged product is missing: ${source}`);
	const safeTarget = assertSafeSyncTarget(target, repoRoot);
	rmSync(safeTarget, { force: true, recursive: true });
	cpSync(source, safeTarget, { recursive: true });
	return safeTarget;
}

export function readDeliveryManifest(directory) {
	return JSON.parse(readFileSync(join(directory, DELIVERY_MANIFEST_JSON), "utf8"));
}

export function verifyDelivery(source, target) {
	const sourceManifest = readDeliveryManifest(source);
	const targetManifest = readDeliveryManifest(target);
	if (sourceManifest.buildId !== targetManifest.buildId) {
		throw new Error(`Build ID mismatch: ${sourceManifest.buildId} != ${targetManifest.buildId}`);
	}
	const sourceTree = computeTreeDigest(source);
	const targetTree = computeTreeDigest(target);
	if (sourceTree.sha256 !== sourceManifest.tree.sha256 || sourceTree.fileCount !== sourceManifest.tree.fileCount) {
		throw new Error("Packaged product does not match its build manifest");
	}
	if (targetTree.sha256 !== sourceTree.sha256 || targetTree.fileCount !== sourceTree.fileCount) {
		throw new Error("Synchronized product does not match the packaged product");
	}
	return { buildId: sourceManifest.buildId, tree: sourceTree };
}

export function formatManifestText(manifest) {
	const components = Object.entries(manifest.components)
		.map(([name, value]) => `${name}: ${value.path}\n  SHA256 ${value.sha256}`)
		.join("\n");
	return `AutoPi product build

Build ID: ${manifest.buildId}
Built at: ${manifest.builtAt}
Platform: ${manifest.platform}
Product version: ${manifest.productVersion}
Core CLI version: ${manifest.coreVersion}
Electron version: ${manifest.electronVersion}
Source revision: ${manifest.sourceRevision}${manifest.sourceDirty ? " (dirty working tree)" : ""}
Product tree: ${manifest.tree.fileCount} files
Product tree SHA256: ${manifest.tree.sha256}

${components}
`;
}
