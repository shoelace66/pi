import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertSafeSyncTarget,
	computeTreeDigest,
	DELIVERY_MANIFEST_JSON,
	synchronizeDelivery,
	verifyDelivery,
} from "./desktop-release-lib.mjs";

test("tree digest is stable and ignores delivery manifests", async () => {
	const root = await mkdtemp(join(tmpdir(), "autopi-tree-"));
	try {
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "nested", "b.txt"), "two");
		await writeFile(join(root, "a.txt"), "one");
		const first = computeTreeDigest(root);
		await writeFile(join(root, DELIVERY_MANIFEST_JSON), "{}");
		assert.deepEqual(computeTreeDigest(root), first);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("synchronized delivery retains the same build and tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "autopi-sync-"));
	try {
		const source = join(root, "source");
		const target = join(root, "AutoPi");
		await mkdir(source);
		await writeFile(join(source, "AutoPi.exe"), "binary");
		const tree = computeTreeDigest(source);
		await writeFile(
			join(source, DELIVERY_MANIFEST_JSON),
			`${JSON.stringify({ buildId: "test-build", tree })}\n`,
		);
		synchronizeDelivery(source, target, join(root, "repo"));
		assert.deepEqual(verifyDelivery(source, target), { buildId: "test-build", tree });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("unsafe delivery roots are rejected", () => {
	const driveRoot = process.platform === "win32" ? "D:\\" : "/";
	assert.throws(() => assertSafeSyncTarget(driveRoot, join(driveRoot, "repo")), /unsafe delivery target/);
});
