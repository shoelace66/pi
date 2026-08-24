export const RELEASE_TARGETS = Object.freeze({
	"win32-x64": Object.freeze({
		name: "win32-x64",
		platform: "win32",
		arch: "x64",
		bunHostPackage: "bun-windows-x64",
		bunRuntimePackage: "bun-windows-x64-baseline",
		bunTarget: "bun-windows-x64-baseline",
		executableName: "autopi.exe",
		nodeExecutableName: "node.exe",
		clipboardPackage: "clipboard-win32-x64-msvc",
		clipboardFile: "clipboard.win32-x64-msvc.node",
	}),
	"linux-x64": Object.freeze({
		name: "linux-x64",
		platform: "linux",
		arch: "x64",
		bunHostPackage: "bun-linux-x64",
		bunRuntimePackage: "bun-linux-x64-baseline",
		bunTarget: "bun-linux-x64-baseline",
		executableName: "autopi",
		nodeExecutableName: "node",
		clipboardPackage: "clipboard-linux-x64-gnu",
		clipboardFile: "clipboard.linux-x64-gnu.node",
	}),
});

export function getReleaseTarget(name) {
	const target = RELEASE_TARGETS[name];
	if (!target) throw new Error(`Unsupported release target: ${name}. Expected win32-x64 or linux-x64.`);
	return target;
}

export function hostReleaseTarget(platform = process.platform, arch = process.arch) {
	const name = `${platform}-${arch}`;
	return Object.hasOwn(RELEASE_TARGETS, name) ? RELEASE_TARGETS[name] : undefined;
}

export function targetMatchesHost(target, platform = process.platform, arch = process.arch) {
	return target.platform === platform && target.arch === arch;
}
