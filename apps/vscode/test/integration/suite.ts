import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";

async function withTimeout<T>(operation: Thenable<T>, label: string, timeoutMs = 60_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension("shoelace66.autopi");
	assert.ok(extension, "AutoPi extension was not discovered by the extension host");
	const config = vscode.workspace.getConfiguration("autopi");
	await config.update("backendPath", "", vscode.ConfigurationTarget.Global);
	await config.update("backendArgs", ["--no-session", "--offline"], vscode.ConfigurationTarget.Global);
	await extension.activate();

	assert.equal(vscode.workspace.isTrusted, true, "trusted integration run did not enable the workspace host");
	assert.equal(vscode.workspace.workspaceFolders?.length, 2, "multi-root workspace did not expose both folders");
	assert.deepEqual(extension.packageJSON.extensionKind, ["workspace"]);
	assert.equal(extension.packageJSON.capabilities?.untrustedWorkspaces?.supported, "limited");
	assert.equal(extension.packageJSON.version, process.env.AUTOPI_INTEGRATION_EXTENSION_VERSION);
	if (process.env.AUTOPI_INTEGRATION_EXPECT_INSTALLED === "1") {
		const extensionsDirectory = process.env.AUTOPI_INTEGRATION_EXTENSIONS_DIR;
		assert.ok(extensionsDirectory, "installed integration profile did not expose its extensions directory");
		const relativeExtensionPath = path.relative(extensionsDirectory, extension.extensionPath);
		assert.ok(
			relativeExtensionPath !== ".." &&
				!relativeExtensionPath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativeExtensionPath),
			`AutoPi was not loaded from the isolated installed-extension profile: ${extension.extensionPath}`,
		);
	}

	const commands = await vscode.commands.getCommands(true);
	for (const command of ["autopi.focus", "autopi.newSession", "autopi.configureApiKey", "autopi.refresh"]) {
		assert.ok(commands.includes(command), `AutoPi command was not registered: ${command}`);
	}
	await withTimeout(
		vscode.commands.executeCommand("autopi.newSession"),
		"AutoPi bundled backend startup and newSession RPC",
	);
	await withTimeout(vscode.commands.executeCommand("autopi.refresh"), "AutoPi get_state/get_messages refresh RPC");

	const projectA = process.env.AUTOPI_INTEGRATION_PROJECT_A;
	assert.ok(projectA, "integration report fixture was not configured");
	const reportPath = path.join(projectA, "reports", "eval.md");
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
	await vscode.window.showTextDocument(document, { preview: false });
	assert.equal(document.getText().startsWith("# Evaluation"), true, "generated report did not open in the editor");
}
