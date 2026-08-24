import assert from "node:assert/strict";
import test from "node:test";
import { getReleaseTarget, hostReleaseTarget, targetMatchesHost } from "./release-targets.mjs";

test("release targets describe Windows and Linux x64 backends", () => {
	assert.deepEqual(
		{
			windows: getReleaseTarget("win32-x64").executableName,
			linux: getReleaseTarget("linux-x64").executableName,
		},
		{ windows: "autopi.exe", linux: "autopi" },
	);
	assert.equal(getReleaseTarget("linux-x64").clipboardFile, "clipboard.linux-x64-gnu.node");
});

test("host matching rejects unsupported architectures", () => {
	assert.equal(hostReleaseTarget("linux", "x64")?.name, "linux-x64");
	assert.equal(hostReleaseTarget("linux", "arm64"), undefined);
	assert.equal(targetMatchesHost(getReleaseTarget("linux-x64"), "linux", "x64"), true);
	assert.equal(targetMatchesHost(getReleaseTarget("linux-x64"), "win32", "x64"), false);
});

test("unknown release targets are rejected", () => {
	assert.throws(() => getReleaseTarget("linux-arm64"), /Unsupported release target/);
});
